import { ConfigurationError } from './configuration-error.ts';
const model = 'gpt-realtime-2.1-mini';
const transcriptionModel = 'gpt-live-transcribe';
const voice = 'marin';

/** Server-owned defaults. Transcription runs alongside the voice conversation. */
export const AGENT_CONFIG = {
  model: model,
  transcriptionModel,
  voice,
  instructions: `
      You are the Living Community Assistant, a friendly conversational assistant. 
      Speak naturally and keep replies brief. 
      Follow the user’s language, ask one question at a time, and acknowledge uncertainty. 
      You cannot access community records or take actions.
    `,
  turnDetection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: true,
  },
  setupTimeoutMs: 10_000,
  maxQueuedBytes: 24_000,
  maxOutputQueueMs: 60_000,
} as const;

export function readOpenAIKey(env: NodeJS.ProcessEnv = process.env) {
  return env.OPENAI_API_KEY?.trim();
}

export function readOutputQueueMs(
  value: string | number = AGENT_CONFIG.maxOutputQueueMs,
): number {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 120_000)
    throw new ConfigurationError(
      'VOICE_OUTPUT_QUEUE_MS must be an integer between 1000 and 120000.',
    );
  return duration;
}
