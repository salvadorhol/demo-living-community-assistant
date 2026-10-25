import {
  createTranscriptObservation,
  type ResponseTarget,
} from './transcript-observer.ts';
import { ConfigurationError, voiceError } from '../configuration-error.ts';
import { silentLogger } from '../logger.ts';
import type {
  AudioOutputEvent,
  TranscriptUpdate,
  AudioPlaybackProgress,
  AudioAck,
  AudioStream,
  AudioChunk,
  AudioStreamEnd,
} from '@living-community-assistant/types';
import type { ProviderTranscript, VoiceAgent } from '../ai/contracts.ts';
import { SavedCall } from '../calls/saved-call.ts';
import type { ConversationOptions, ConversationSession } from './contracts.ts';

export function createConversationSession({
  uid,
  roomId,
  authentication = {},
  factory,
  store,
  maxCallMs = 60 * 60 * 1000,
  logger = silentLogger,
  events,
  observerFactory,
}: ConversationOptions): ConversationSession {
  let disconnected = false;
  const connected = () => !disconnected;
  let activity = 0;
  let activitySignal = new AbortController();
  let observation: ReturnType<typeof createTranscriptObservation> | undefined;
  const providerReferences = new Map<
    string,
    Pick<ProviderTranscript, 'providerItemId' | 'providerResponseId' | 'source'>
  >();
  function invalidateObservation() {
    activity++;
    activitySignal.abort();
    activitySignal = new AbortController();
  }
  function validTarget(target: ResponseTarget) {
    const valid = Boolean(
      !closed &&
        !ending &&
        input?.ready &&
        call?.id === target.callId &&
        generation === target.generation &&
        activity === target.activity &&
        target.responseId &&
        agent?.currentResponseId?.() === target.responseId,
    );
    if (!valid)
      logger.debug(
        { event: 'conversation.stale_control', callId: target.callId },
        'Ignoring stale response control',
      );
    return valid;
  }
  async function applyControl(
    target: ResponseTarget,
    instructions?: string,
  ): Promise<boolean> {
    if (!validTarget(target) || !target.responseId || !agent) return false;
    if (
      instructions !== undefined &&
      (!instructions.trim() || instructions.length > 16_000)
    )
      throw new Error(
        'Corrective instructions must contain 1–16000 characters.',
      );
    const signal = activitySignal.signal;
    const applied =
      instructions === undefined
        ? await agent.interruptResponse?.(target.responseId, signal)
        : await agent.redirectResponse?.(
            target.responseId,
            instructions,
            signal,
          );
    return applied ?? false;
  }
  function publishTranscript(update: TranscriptUpdate) {
    events.transcript(update);
    if (!call || !update.callId || !update.revision) return;
    const reference = providerReferences.get(update.id);
    const target: ResponseTarget = Object.freeze({
      callId: call.id,
      generation,
      activity,
      responseId: reference?.providerResponseId ?? agent?.currentResponseId?.(),
    });
    observation?.publish(
      {
        ...update,
        callId: update.callId,
        revision: update.revision,
        ...reference,
        source:
          reference?.source ??
          (update.role === 'user' ? 'transcription' : 'voice'),
      },
      {
        signal: activitySignal.signal,
        target,
        interruptResponse: (target) => applyControl(target),
        redirectResponse: (target, instructions) =>
          applyControl(target, instructions),
      },
    );
  }
  function acceptTranscript(value: ProviderTranscript, owner: number) {
    if (owner !== generation || !call) return;
    const { providerItemId, providerResponseId, source, ...update } = value;
    providerReferences.set(value.id, {
      providerItemId,
      providerResponseId,
      source,
    });
    call.update(update);
  }
  let agent: VoiceAgent | undefined;
  let generation = 0;
  let call: SavedCall | undefined;
  let ending: Promise<void> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let initializing = false;
  let closed = false;
  let lastCallId: string | undefined;
  const retained = new Map<string, SavedCall>();
  function endBackground(reason: string) {
    void end(reason).catch((err) =>
      logger.error(
        { event: 'call.finalization_failed', err, callId: call?.id, reason },
        'Call finalization failed',
      ),
    );
  }
  async function end(reason: string) {
    if (ending) return ending;
    const current = call;
    if (!current) return;
    clearTimeout(limit);
    invalidateObservation();
    observation?.dispose();
    const started = Date.now();
    logger.info(
      { event: 'call.ending', callId: current.id, reason },
      'Ending call',
    );
    current.ending();
    lastCallId = current.id;
    input = undefined;
    const old = agent;
    ending = (async () => {
      try {
        old?.pause();
      } catch (err) {
        logger.debug(
          { event: 'voice.pause_failed', err, callId: current.id },
          'Provider already unavailable during finalization',
        );
      }
      try {
        await old?.finish?.();
      } catch (err) {
        logger.warn(
          { event: 'transcription.finish_failed', err, callId: current.id },
          'Transcription finalization failed',
        );
        current.degraded();
      }
      dispose();
      call = undefined;
      await current.finish(reason);
      logger.info(
        {
          event: 'call.ended',
          callId: current.id,
          reason,
          state: current.state,
          durationMs: Date.now() - started,
        },
        'Call finalization completed',
      );
      if (current.state === 'failed') retained.set(current.id, current);
    })().finally(() => {
      ending = undefined;
    });
    return ending;
  }
  let input: { id: string; sequence: number; ready: boolean } | undefined;
  const failed = (error?: unknown): AudioAck => {
    const failure = voiceError(error);
    return {
      ok: false,
      code:
        error instanceof ConfigurationError
          ? 'VOICE_CONFIGURATION_ERROR'
          : 'AUDIO_FAILED',
      message: failure.message,
    };
  };
  function dispose() {
    generation++;
    invalidateObservation();
    observation?.dispose();
    observation = undefined;
    providerReferences.clear();
    input = undefined;
    const old = agent;
    agent = undefined;
    old?.dispose();
  }
  function output(event: AudioOutputEvent, owner: number) {
    if (owner !== generation) return;
    if (event.type === 'clear') call?.recording.clear(event.streamId);
    if (!connected()) return;
    if (event.type === 'chunk')
      call?.recording.append(event.chunk.streamId, event.chunk.data);
    events.output(event);
    if (event.type === 'error') endBackground('provider_error');
  }
  return {
    async start(value: AudioStream): Promise<AudioAck> {
      if (
        closed ||
        !connected() ||
        input ||
        ending ||
        initializing ||
        retained.size >= 3
      ) {
        return {
          ok: false,
          code: 'BUSY',
          message: 'An input stream is already active.',
        };
      }
      const run = { id: value.streamId, sequence: 0, ready: false };
      input = run;
      initializing = true;
      const started = Date.now();
      try {
        if (!agent) {
          const owner = ++generation;
          const current = new SavedCall(
            uid,
            store,
            (status) => {
              if (connected()) events.status(status);
            },
            (update) => {
              if (connected()) publishTranscript(update);
            },
            logger,
            factory.metadata,
          );
          call = current;
          observation = createTranscriptObservation(
            observerFactory,
            { callId: current.id, uid },
            logger,
          );
          await current.start(roomId, authentication);
          if (input !== run || !connected() || ending) {
            await end('cancelled');
            return failed();
          }
          limit = setTimeout(() => {
            events.output({
              type: 'error',
              error: {
                code: 'VOICE_UNAVAILABLE',
                message: 'Call duration limit reached.',
              },
            });
            endBackground('duration_limit');
          }, maxCallMs);
          limit.unref();
          agent = factory.create({
            uid: uid,
            callId: current.id,
            logger: logger.child({ callId: current.id }),
            transcript: (value) => acceptTranscript(value, owner),
            speechStarted: () => {
              if (owner === generation) invalidateObservation();
            },
            responseStarted: () => {
              if (owner === generation) invalidateObservation();
            },
            degraded: () => current.degraded(),
            metadata: (info) => current.metadata(info),
            output: (event) => output(event, owner),
          });
        }
        const session = agent;
        await session.initialize();
        if (input !== run || agent !== session || !connected()) {
          return {
            ok: false,
            code: 'INVALID_STREAM',
            message: 'Voice start cancelled.',
          };
        }
        session.beginInput();
        run.ready = true;
        logger.info(
          {
            event: 'voice.ready',
            callId: call?.id,
            durationMs: Date.now() - started,
          },
          'Voice input ready',
        );
        call?.pause(false);
        return { ok: true };
      } catch (err) {
        logger.error(
          { event: 'conversation.operation_failed', err, callId: call?.id },
          'Conversation operation failed',
        );
        if (input === run) {
          try {
            await end('start_failed');
          } catch (finalizeError) {
            logger.error(
              {
                event: 'call.finalization_failed',
                err: finalizeError,
                callId: call?.id,
              },
              'Failed start cleanup failed',
            );
          }
        }
        if (err instanceof ConfigurationError)
          events.output({ type: 'error', error: voiceError(err) });
        return failed(err);
      } finally {
        initializing = false;
      }
    },
    write(value: AudioChunk): AudioAck {
      if (!input?.ready || !value || value.streamId !== input.id) {
        return {
          ok: false,
          code: 'INVALID_STREAM',
          message: 'No matching input stream.',
        };
      }
      if (value.sequence !== input.sequence)
        return {
          ok: false,
          code: 'INVALID_AUDIO',
          message: 'Invalid PCM chunk or sequence.',
        };
      try {
        agent?.write(value.data);
        call?.recording.append(`input-${input.id}`, value.data, true);
        input.sequence++;
        return { ok: true };
      } catch (err) {
        logger.error(
          { event: 'conversation.operation_failed', err, callId: call?.id },
          'Conversation operation failed',
        );
        endBackground('provider_error');
        events.output({
          type: 'error',
          error: {
            code: 'VOICE_UNAVAILABLE',
            message: 'Voice connection fell behind or failed. Try Start again.',
          },
        });
        return failed();
      }
    },
    pause(value: AudioStreamEnd): AudioAck {
      if (!input || value?.streamId !== input.id) {
        return {
          ok: false,
          code: 'INVALID_STREAM',
          message: 'No matching input stream.',
        };
      }
      const ready = input.ready;
      invalidateObservation();
      input = undefined;
      try {
        if (ready) {
          agent?.pause();
          call?.pause(true);
        } else endBackground('cancelled'); // Cancel initialization rather than leaving a late connection alive.
        return { ok: true };
      } catch (err) {
        logger.error(
          { event: 'conversation.operation_failed', err, callId: call?.id },
          'Conversation operation failed',
        );
        endBackground('provider_error');
        return failed();
      }
    },
    progress(value: AudioPlaybackProgress) {
      try {
        agent?.progress(value);
        call?.recording.progress(value.streamId, value.playedMs);
      } catch (err) {
        logger.error(
          { event: 'conversation.operation_failed', err, callId: call?.id },
          'Conversation operation failed',
        );
        endBackground('provider_error');
        events.output({
          type: 'error',
          error: {
            code: 'VOICE_UNAVAILABLE',
            message: 'Voice connection failed. Try Start again.',
          },
        });
      }
    },
    end(callId: string): AudioAck {
      if (call?.id !== callId && lastCallId !== callId && !retained.has(callId))
        return {
          ok: false,
          code: 'INVALID_STREAM',
          message: 'No matching call.',
        };
      if (call?.id === callId) endBackground('ended');
      return { ok: true };
    },
    retrySave(callId: string): AudioAck {
      const current = retained.get(callId);
      if (!current || current.uid !== uid)
        return {
          ok: false,
          code: 'INVALID_STREAM',
          message: 'No matching failed call.',
        };
      logger.info({ event: 'call.retry', callId }, 'Retrying call save');
      void current
        .finish('ended')
        .then(() => {
          if (current.state === 'saved') retained.delete(current.id);
        })
        .catch((err) =>
          logger.error(
            { event: 'call.retry_failed', err, callId },
            'Call retry failed',
          ),
        );
      return { ok: true };
    },
    disconnect() {
      disconnected = true;
      closed = true;
      return end('disconnect');
    },
    close() {
      closed = true;
      return end('shutdown');
    },
  };
}
