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
      Use the available tools when asked about tour appointments or floor plans; do not invent availability.
      Tool results marked mock are demonstration data, not live availability. Clearly call them sample values.
      You can look up tour slots and floor plans, but cannot book, reserve, change records, or take other actions.
      If a lookup fails, explain that the information could not be retrieved and do not fabricate a result.
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
