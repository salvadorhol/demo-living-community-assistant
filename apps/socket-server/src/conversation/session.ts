import type {DecisionUtterance} from '../ai/openai/injection-check.ts';
import {
  createTranscriptObservation,
  type ResponseTarget,
} from './transcript-observer.ts';
import {ConfigurationError, voiceError} from '../configuration-error.ts';
import {silentLogger} from '../logger.ts';
import type {
  AudioOutputEvent,
  CallEndReason,
  TranscriptUpdate,
  AudioPlaybackProgress,
  AudioAck,
  AudioStream,
  AudioChunk,
  AudioStreamEnd,
} from '@living-community-assistant/types';
import type {ProviderTranscript, VoiceAgent} from '../ai/contracts.ts';
import {SavedCall} from '../calls/saved-call.ts';
import type {ConversationOptions, ConversationSession} from './contracts.ts';

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
  guardrail,
}: ConversationOptions): ConversationSession {
  let safetyStopped = false;
  let safetySignal = new AbortController();
  let safetyQueue: Promise<void> = Promise.resolve();
  const checked = new Set<string>();
  const history = new Map<string, DecisionUtterance>();
  function terminateSafety(
    reason: 'prompt_injection' | 'guardrail_unavailable',
    owner: number
  ) {
    if (owner !== generation || !call || safetyStopped || ending || closed)
      return;
    safetyStopped = true;
    safetySignal.abort();
    if (closing) {
      clearTimeout(closing.timer);
      closing = undefined;
    }
    const callId = call.id;
    events.output({
      type: 'warning',
      warning: {
        callId,
        code:
          reason === 'prompt_injection'
            ? 'PROMPT_INJECTION_DETECTED'
            : 'GUARDRAIL_UNAVAILABLE',
        message:
          reason === 'prompt_injection'
            ? 'Potential prompt injection detected. The call has been ended.'
            : 'The safety check is unavailable. The call has been ended.',
      },
    });
    events.output({type: 'closing', callId, reason});
    events.status({callId, state: 'closing', endReason: reason});
    // Dispose immediately; ordinary finalization may wait for final ASR results.
    const old = agent;
    agent = undefined;
    input = undefined;
    try {
      old?.dispose();
    } catch {
      /* Finalize even if upstream cleanup fails. */
    }
    endBackground(reason);
  }
  function checkTranscript(value: ProviderTranscript, owner: number) {
    if (
      !guardrail ||
      safetyStopped ||
      ending ||
      value.role !== 'user' ||
      value.source !== 'transcription' ||
      !value.isFinal ||
      value.incomplete ||
      !value.text.trim() ||
      checked.has(value.id)
    )
      return;
    checked.add(value.id);
    const preceding = [...history.values()];
    let remaining = 12000;
    for (let i = preceding.length - 1; i >= 0; i--) {
      preceding[i] = {
        ...preceding[i],
        text: preceding[i].text.slice(-remaining),
      };
      remaining -= preceding[i].text.length;
      if (!remaining) {
        preceding.splice(0, i);
        break;
      }
    }
    const lifetime = safetySignal.signal;
    const request = new AbortController();
    const cancel = () => request.abort();
    lifetime.addEventListener('abort', cancel, {once: true});
    const started = Date.now();
    const timer = setTimeout(() => {
      request.abort();
      if (!lifetime.aborted) {
        logger.warn(
          {
            event: 'guardrail.failed',
            callId: call?.id,
            utteranceId: value.id,
            category: 'timeout',
          },
          'Safety check timed out'
        );
        terminateSafety('guardrail_unavailable', owner);
      }
    }, guardrail.timeoutMs);
    safetyQueue = safetyQueue
      .then(async () => {
        if (lifetime.aborted || request.signal.aborted) return;
        try {
          const decision = await guardrail.check(
            value.text,
            preceding,
            request.signal
          );
          if (
            lifetime.aborted ||
            request.signal.aborted ||
            owner !== generation
          )
            return;
          logger.info(
            {
              event: 'guardrail.verdict',
              callId: call?.id,
              utteranceId: value.id,
              model: 'gpt-6-luna',
              promptInjectionProbability: decision.promptInjectionProbability,
              frustrationProbability: decision.frustrationProbability,
              language: decision.language,
              latencyMs: Date.now() - started,
            },
            'Safety check completed'
          );
          if (decision.promptInjectionProbability >= guardrail.threshold)
            terminateSafety('prompt_injection', owner);
          else if (
            decision.frustrationProbability >= guardrail.frustrationThreshold
          )
            startManagerHandoff(decision.language, owner);
        } catch {
          if (!lifetime.aborted) {
            logger.warn(
              {
                event: 'guardrail.failed',
                callId: call?.id,
                utteranceId: value.id,
                category: 'decisions_unavailable',
              },
              'Safety check unavailable'
            );
            terminateSafety('guardrail_unavailable', owner);
          }
        }
      })
      .finally(() => {
        clearTimeout(timer);
        lifetime.removeEventListener('abort', cancel);
      });
  }
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
      !closing &&
      input?.ready &&
      call?.id === target.callId &&
      generation === target.generation &&
      activity === target.activity &&
      target.responseId &&
      agent?.currentResponseId?.() === target.responseId
    );
    if (!valid)
      logger.debug(
        {event: 'conversation.stale_control', callId: target.callId},
        'Ignoring stale response control'
      );
    return valid;
  }
  async function applyControl(
    target: ResponseTarget,
    instructions?: string
  ): Promise<boolean> {
    if (!validTarget(target) || !target.responseId || !agent) return false;
    if (
      instructions !== undefined &&
      (!instructions.trim() || instructions.length > 16_000)
    )
      throw new Error(
        'Corrective instructions must contain 1–16000 characters.'
      );
    const signal = activitySignal.signal;
    const applied =
      instructions === undefined
        ? await agent.interruptResponse?.(target.responseId, signal)
        : await agent.redirectResponse?.(
            target.responseId,
            instructions,
            signal
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
        interruptResponse: target => applyControl(target),
        redirectResponse: (target, instructions) =>
          applyControl(target, instructions),
      }
    );
  }
  function acceptTranscript(value: ProviderTranscript, owner: number) {
    if (owner !== generation || !call) return;
    const {providerItemId, providerResponseId, source, ...update} = value;
    providerReferences.set(value.id, {
      providerItemId,
      providerResponseId,
      source,
    });
    call.update(update);
    checkTranscript(value, owner);
    if (
      value.isFinal &&
      !value.incomplete &&
      value.text.trim() &&
      !history.has(value.id)
    ) {
      history.set(value.id, {role: value.role, text: value.text.slice(-12000)});
      if (history.size > 6)
        history.delete(history.keys().next().value as string);
    }
  }
  let agent: VoiceAgent | undefined;
  let generation = 0;
  let call: SavedCall | undefined;
  let closing:
    | {
        reason: CallEndReason;
        streamId?: string;
        bytes: number;
        playedMs: number;
        delivered: boolean;
        generated: boolean;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  function beginClosing(
    action: {reason: CallEndReason; immediate: boolean},
    owner: number
  ) {
    if (owner !== generation || !call || ending || safetyStopped) return;
    if (closing) {
      if (action.reason !== 'visitor_requested' || !action.immediate) return;
      clearTimeout(closing.timer);
    }
    invalidateObservation();
    closing = {
      reason: action.reason,
      bytes: 0,
      playedMs: 0,
      delivered: false,
      generated: false,
      timer: setTimeout(() => endBackground(action.reason), 15000),
    };
    closing.timer.unref();
    events.output({
      type: 'closing',
      callId: call.id,
      reason: action.reason,
    });
    events.status({
      callId: call.id,
      state: 'closing',
      endReason: action.reason,
    });
    if (action.immediate) endBackground(action.reason);
  }
  function startManagerHandoff(language: 'en' | 'es', owner: number) {
    if (
      owner !== generation ||
      !call ||
      !agent ||
      closing ||
      ending ||
      safetyStopped ||
      closed
    )
      return;
    beginClosing({reason: 'demo_manager_handoff', immediate: false}, owner);
    const message =
      language === 'es'
        ? 'Lamento que esto haya sido frustrante. Esta demostración ahora simulará la transferencia a un gerente. Gracias por su paciencia.'
        : 'I’m sorry this has been frustrating. This demo will now simulate transferring you to a manager. Thank you for your patience.';
    const signal = safetySignal.signal;
    try {
      // Invoke synchronously so provider tool work is disabled before another microtask runs.
      const pending = agent.speakTerminalMessage?.(message, signal) ?? false;
      void Promise.resolve(pending)
        .then(applied => {
          if (!applied && !signal.aborted && owner === generation) {
            logger.warn(
              {event: 'manager_handoff.failed', callId: call?.id},
              'Manager closing speech unavailable'
            );
            endBackground('demo_manager_handoff');
          }
        })
        .catch(() => {
          if (!signal.aborted && owner === generation)
            endBackground('demo_manager_handoff');
        });
    } catch {
      endBackground('demo_manager_handoff');
    }
  }
  function finishClosingIfPlayed() {
    if (
      closing?.generated &&
      closing.delivered &&
      closing.bytes > 0 &&
      closing.playedMs >= Math.floor(closing.bytes / 48)
    )
      endBackground(closing.reason);
  }
  let ending: Promise<void> | undefined;
  let limit: ReturnType<typeof setTimeout> | undefined;
  let initializing = false;
  let closed = false;
  let lastCallId: string | undefined;
  const retained = new Map<string, SavedCall>();
  function endBackground(reason: string) {
    void end(reason).catch(err =>
      logger.error(
        {event: 'call.finalization_failed', err, callId: call?.id, reason},
        'Call finalization failed'
      )
    );
  }
  async function end(reason: string) {
    if (ending) return ending;
    const current = call;
    if (!current) return;
    if (closing) {
      if (reason !== 'visitor_requested') reason = closing.reason;
      clearTimeout(closing.timer);
      closing = undefined;
    }
    clearTimeout(limit);
    safetySignal.abort();
    invalidateObservation();
    observation?.dispose();
    const started = Date.now();
    logger.info(
      {event: 'call.ending', callId: current.id, reason},
      'Ending call'
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
          {event: 'voice.pause_failed', err, callId: current.id},
          'Provider already unavailable during finalization'
        );
      }
      try {
        await old?.finish?.();
      } catch (err) {
        logger.warn(
          {event: 'transcription.finish_failed', err, callId: current.id},
          'Transcription finalization failed'
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
        'Call finalization completed'
      );
      if (current.state === 'failed') retained.set(current.id, current);
    })().finally(() => {
      ending = undefined;
    });
    return ending;
  }
  let input: {id: string; sequence: number; ready: boolean} | undefined;
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
    if (owner !== generation || safetyStopped) return;
    if (closing) {
      if (event.type === 'start') {
        closing.streamId = event.stream.streamId;
        closing.bytes = 0;
        closing.playedMs = 0;
        closing.delivered = false;
      }
      if (event.type === 'chunk' && event.chunk.streamId === closing.streamId)
        closing.bytes += event.chunk.data.byteLength;
      if (event.type === 'end' && event.streamId === closing.streamId)
        closing.delivered = true;
    }
    if (event.type === 'clear') call?.recording.clear(event.streamId);
    if (!connected()) return;
    if (event.type === 'chunk')
      call?.recording.append(event.chunk.streamId, event.chunk.data);
    events.output(event);
    if (event.type === 'end') finishClosingIfPlayed();
    if (event.type === 'error') endBackground('provider_error');
  }
  return {
    async start(value: AudioStream): Promise<AudioAck> {
      if (
        closed ||
        !connected() ||
        input ||
        ending ||
        closing ||
        initializing ||
        retained.size >= 3
      ) {
        return {
          ok: false,
          code: 'BUSY',
          message: 'An input stream is already active.',
        };
      }
      const run = {id: value.streamId, sequence: 0, ready: false};
      input = run;
      initializing = true;
      const started = Date.now();
      try {
        if (!agent) {
          safetyStopped = false;
          safetySignal = new AbortController();
          safetyQueue = Promise.resolve();
          checked.clear();
          history.clear();
          const owner = ++generation;
          const current = new SavedCall(
            uid,
            store,
            status => {
              if (connected()) events.status(status);
            },
            update => {
              if (connected()) publishTranscript(update);
            },
            logger,
            factory.metadata
          );
          call = current;
          observation = createTranscriptObservation(
            observerFactory,
            {callId: current.id, uid},
            logger
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
            logger: logger.child({callId: current.id}),
            transcript: value => acceptTranscript(value, owner),
            closing(action = {reason: 'demo_sales_handoff', immediate: false}) {
              beginClosing(action, owner);
            },
            closingResponseDone() {
              if (owner !== generation || !closing) return;
              closing.generated = true;
              finishClosingIfPlayed();
            },
            speechStarted: () => {
              if (owner === generation) invalidateObservation();
            },
            responseStarted: () => {
              if (owner === generation) invalidateObservation();
            },
            degraded: () => {
              if (owner !== generation || ending || safetyStopped) return;
              current.degraded();
              if (guardrail) terminateSafety('guardrail_unavailable', owner);
            },
            metadata: info => current.metadata(info),
            output: event => output(event, owner),
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
          'Voice input ready'
        );
        call?.pause(false);
        return {ok: true};
      } catch (err) {
        logger.error(
          {event: 'conversation.operation_failed', err, callId: call?.id},
          'Conversation operation failed'
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
              'Failed start cleanup failed'
            );
          }
        }
        if (err instanceof ConfigurationError)
          events.output({type: 'error', error: voiceError(err)});
        return failed(err);
      } finally {
        initializing = false;
      }
    },
    write(value: AudioChunk): AudioAck {
      if (closing && value?.streamId === input?.id) return {ok: true};
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
        return {ok: true};
      } catch (err) {
        logger.error(
          {event: 'conversation.operation_failed', err, callId: call?.id},
          'Conversation operation failed'
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
      if (closing && value?.streamId === input?.id) return {ok: true};
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
        return {ok: true};
      } catch (err) {
        logger.error(
          {event: 'conversation.operation_failed', err, callId: call?.id},
          'Conversation operation failed'
        );
        endBackground('provider_error');
        return failed();
      }
    },
    progress(value: AudioPlaybackProgress) {
      try {
        agent?.progress(value);
        call?.recording.progress(value.streamId, value.playedMs);
        if (
          closing &&
          value.streamId === closing.streamId &&
          !value.cleared &&
          Number.isFinite(value.playedMs) &&
          value.playedMs >= closing.playedMs &&
          value.playedMs <= closing.bytes / 48
        ) {
          closing.playedMs = value.playedMs;
          finishClosingIfPlayed();
        }
      } catch (err) {
        logger.error(
          {event: 'conversation.operation_failed', err, callId: call?.id},
          'Conversation operation failed'
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
      if (call?.id === callId) {
        if (closing?.reason === 'demo_manager_handoff')
          beginClosing(
            {reason: 'visitor_requested', immediate: true},
            generation
          );
        else endBackground('ended');
      }
      return {ok: true};
    },
    retrySave(callId: string): AudioAck {
      const current = retained.get(callId);
      if (!current || current.uid !== uid)
        return {
          ok: false,
          code: 'INVALID_STREAM',
          message: 'No matching failed call.',
        };
      logger.info({event: 'call.retry', callId}, 'Retrying call save');
      void current
        .finish('ended')
        .then(() => {
          if (current.state === 'saved') retained.delete(current.id);
        })
        .catch(err =>
          logger.error(
            {event: 'call.retry_failed', err, callId},
            'Call retry failed'
          )
        );
      return {ok: true};
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
