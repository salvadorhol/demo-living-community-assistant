const model = 'gpt-realtime-2.1-mini';
const transcriptionModel = 'gpt-live-transcribe';
const voice = 'marin';

/** Server-owned defaults. Transcription runs alongside the voice conversation. */
export const ASSISTANT_PROFILE = {
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
} as const;
