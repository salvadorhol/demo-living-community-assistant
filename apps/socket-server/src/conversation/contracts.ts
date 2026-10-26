import type {InjectionGuardrail} from '../ai/openai/injection-check.ts';
import type {
  AudioOutputEvent,
  AudioPlaybackProgress,
  AudioAck,
  AudioStream,
  AudioChunk,
  AudioStreamEnd,
  CallStatus,
  TranscriptUpdate,
} from '@living-community-assistant/types';
import type {VoiceAgentFactory} from '../ai/contracts.ts';
import type {CallStore} from '../calls/call-store.ts';
import type {AppLogger} from '../logger.ts';
import type {TranscriptObserverFactory} from './transcript-observer.ts';

export interface ConversationEvents {
  output(event: AudioOutputEvent): void;
  status(status: CallStatus): void;
  transcript(update: TranscriptUpdate): void;
}
export interface ConversationOptions {
  uid: string;
  roomId: string;
  authentication?: Record<string, unknown>;
  factory: VoiceAgentFactory;
  store?: CallStore;
  maxCallMs?: number;
  logger?: AppLogger;
  events: ConversationEvents;
  observerFactory?: TranscriptObserverFactory;
  guardrail?: InjectionGuardrail;
}
export interface ConversationSession {
  start(stream: AudioStream): Promise<AudioAck>;
  write(chunk: AudioChunk): AudioAck;
  pause(stream: AudioStreamEnd): AudioAck;
  progress(progress: AudioPlaybackProgress): void;
  end(callId: string): AudioAck;
  retrySave(callId: string): AudioAck;
  disconnect(): Promise<void>;
  close(): Promise<void>;
}
