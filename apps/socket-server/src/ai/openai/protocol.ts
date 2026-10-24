import type WebSocket from 'ws';
import type { AppLogger } from '../../logger.ts';
import { ConfigurationError } from '../../configuration-error.ts';

export type ConnectOpenAI = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;
export interface OpenAIEvent extends Record<string, unknown> {
  type: string;
  session?: { id?: string };
  error?: { code?: string; type?: string; param?: string; event_id?: string };
  item_id?: string;
  content_index?: number;
  delta?: string;
  transcript?: string;
  response_id?: string;
  response?: {
    id: string;
    status: string;
    metadata?: Record<string, string>;
    status_details?: { error?: { code?: string } };
  };
}
export function parseEvent(data: { toString(): string }): OpenAIEvent {
  const event: unknown = JSON.parse(data.toString());
  if (
    !event ||
    typeof event !== 'object' ||
    typeof (event as { type?: unknown }).type !== 'string'
  )
    throw new Error('Invalid OpenAI event');
  return event as OpenAIEvent;
}
export function providerCommandError(
  event: Record<string, unknown>,
  configurationEvents: ReadonlySet<string>,
  ready: boolean,
  logger: AppLogger,
): Error | undefined {
  const error = event.error as
    | { code?: string; type?: string; param?: string; event_id?: string }
    | undefined;
  // VAD may finish cancellation before an explicit cancellation command arrives.
  if (error?.code === 'response_cancel_not_active') return;
  if (
    (error?.event_id && configurationEvents.has(error.event_id)) ||
    (!ready && error?.type === 'invalid_request_error')
  ) {
    logger.error(
      {
        event: 'voice.configuration_rejected',
        providerCode: error?.code,
        parameter: error?.param,
      },
      'OpenAI rejected voice session settings',
    );
    return new ConfigurationError(
      'OpenAI rejected voice session settings. Check the model, voice, and audio configuration.',
    );
  }
  return Object.assign(new Error('Voice provider rejected a command'), {
    code: error?.code,
  });
}

/** Pending command acknowledgements are bounded and cancelled with their owner. */
export class EventAcknowledgements {
  private listeners = new Set<(event: OpenAIEvent) => void>();
  notify(event: OpenAIEvent) {
    for (const listener of [...this.listeners]) listener(event);
  }
  wait(
    predicate: (event: OpenAIEvent) => boolean,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
        signal.removeEventListener('abort', abort);
      };
      const listener = (event: OpenAIEvent) => {
        if (predicate(event)) {
          cleanup();
          resolve();
        }
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Voice response control acknowledgement timed out'));
      }, timeoutMs);
      this.listeners.add(listener);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
