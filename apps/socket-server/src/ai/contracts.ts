import type {
  AudioOutputEvent,
  AudioPlaybackProgress,
  TranscriptUpdate,
} from '@living-community-assistant/types';
import type { AppLogger } from '../logger.ts';

/** Provider identity is internal and never written into the browser transcript schema. */
export interface ProviderTranscript extends TranscriptUpdate {
  providerItemId?: string;
  providerResponseId?: string;
  source?: 'voice' | 'transcription';
}
export interface VoiceAgent {
  initialize(): Promise<void>;
  beginInput(): void;
  write(data: Uint8Array): void;
  pause(): void;
  progress(value: AudioPlaybackProgress): void;
  dispose(): void;
  finish?(): Promise<void>;
  currentResponseId?(): string | undefined;
  interruptResponse?(responseId: string, signal: AbortSignal): Promise<boolean>;
  redirectResponse?(
    responseId: string,
    instructions: string,
    signal: AbortSignal,
  ): Promise<boolean>;
}
export interface VoiceAgentFactory {
  prefetch?(uid: string): void;
  kind: 'conversation';
  metadata?: Readonly<Record<string, string>>;
  create(context: {
    uid: string;
    callId?: string;
    logger?: AppLogger;
    transcript?(event: ProviderTranscript): void;
    speechStarted?(): void;
    responseStarted?(responseId: string): void;
    turnEnded?(): void;
    degraded?(): void;
    metadata?(info: Record<string, string>): void;
    output(event: AudioOutputEvent): void;
  }): VoiceAgent;
}

export interface TranscriptionSession {
  initialize(): Promise<void>;
  write(data: Uint8Array): void;
  commit(): void;
  finish(): Promise<void>;
  dispose(): void;
}
export type TranscriptionFactory = (
  context: Parameters<VoiceAgentFactory['create']>[0],
) => TranscriptionSession;
