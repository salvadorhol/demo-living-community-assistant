import type { TranscriptUpdate } from '@living-community-assistant/types';

export interface CallStore {
  start(
    uid: string,
    callId: string,
    info: Record<string, unknown>,
  ): Promise<void>;
  update(
    uid: string,
    callId: string,
    info: Record<string, unknown>,
  ): Promise<void>;
  transcript(
    uid: string,
    callId: string,
    value: TranscriptUpdate,
  ): Promise<void>;
  upload(
    uid: string,
    callId: string,
    path: string,
    durationMs: number,
  ): Promise<Record<string, unknown>>;
}
export async function retry<T>(
  operation: () => Promise<T>,
  onRetry?: (error: unknown, attempt: number) => void,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === 2) throw error;
      onRetry?.(error, attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}
