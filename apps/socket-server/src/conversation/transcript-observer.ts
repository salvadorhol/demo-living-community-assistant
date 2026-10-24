import type { TranscriptUpdate } from '@living-community-assistant/types';
import type { AppLogger } from '../logger.ts';

export interface ResponseTarget {
  readonly callId: string;
  readonly generation: number;
  readonly activity: number;
  readonly responseId?: string;
}
export interface TranscriptSnapshot extends Readonly<TranscriptUpdate> {
  readonly callId: string;
  readonly revision: number;
  readonly source: 'voice' | 'transcription';
  readonly providerItemId?: string;
  readonly providerResponseId?: string;
}
export interface TranscriptContext {
  readonly signal: AbortSignal;
  readonly target: ResponseTarget;
  interruptResponse(target: ResponseTarget): Promise<boolean>;
  redirectResponse(
    target: ResponseTarget,
    trustedInstructions: string,
  ): Promise<boolean>;
}
export interface TranscriptObserver {
  onTranscript(
    snapshot: TranscriptSnapshot,
    context: TranscriptContext,
  ): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
export type TranscriptObserverFactory = (
  identity: Readonly<{ callId: string; uid: string }>,
) => TranscriptObserver;

/** Observation is optional, isolated from delivery, and owned by one call. */
export function createTranscriptObservation(
  factory: TranscriptObserverFactory | undefined,
  identity: { callId: string; uid: string },
  logger: AppLogger,
) {
  let observer: TranscriptObserver | undefined;
  let disposed = false;
  const failed = (err: unknown) =>
    logger.warn(
      { event: 'conversation.observer_failed', callId: identity.callId, err },
      'Transcript observer failed; conversation continues',
    );
  try {
    observer = factory?.(Object.freeze({ ...identity }));
  } catch (err) {
    failed(err);
  }
  return {
    publish(snapshot: TranscriptSnapshot, context: TranscriptContext) {
      if (!observer || disposed || context.signal.aborted) return;
      const recipient = observer;
      const immutable = Object.freeze({ ...snapshot });
      void Promise.resolve()
        .then(() => {
          if (!disposed && !context.signal.aborted)
            return recipient.onTranscript(immutable, Object.freeze(context));
        })
        .catch(failed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const recipient = observer;
      observer = undefined;
      void Promise.resolve()
        .then(() => recipient?.dispose?.())
        .catch(failed);
    },
  };
}
