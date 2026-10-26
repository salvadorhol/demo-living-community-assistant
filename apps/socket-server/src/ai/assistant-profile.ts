const model = 'gpt-realtime-2.1-mini';
const transcriptionModel = 'gpt-live-transcribe';
const voice = 'marin';

/** Server-owned defaults. Transcription runs alongside the voice conversation. */
export const ASSISTANT_PROFILE = {
  model: model,
  transcriptionModel,
  voice,
  turnDetection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
    create_response: true,
    interrupt_response: true,
  },
} as const;
