import type {
  VoiceAgent,
  VoiceAgentFactory,
  TranscriptionFactory,
} from './contracts.ts';

/** Fan out validated PCM and coordinate turn commits; providers own their own connections. */
export function createVoiceAgent({
  voice,
  transcription,
  metadata = {},
}: {
  voice: VoiceAgentFactory;
  transcription: TranscriptionFactory;
  metadata?: Readonly<Record<string, string>>;
}): VoiceAgentFactory {
  return {
    kind: 'conversation',
    metadata: { ...voice.metadata, ...metadata },
    create(context) {
      const captions = transcription(context);
      let agent: VoiceAgent;
      try {
        agent = voice.create({
          ...context,
          turnEnded: () => {
            captions.commit();
            context.turnEnded?.();
          },
        });
      } catch (err) {
        captions.dispose();
        throw err;
      }
      return {
        async initialize() {
          await agent.initialize();
          await captions.initialize();
        },
        beginInput() {
          agent.beginInput();
        },
        write(data) {
          agent.write(data);
          captions.write(data);
        },
        pause() {
          captions.commit();
          agent.pause();
        },
        progress(value) {
          agent.progress(value);
        },
        async finish() {
          await captions.finish();
          await agent.finish?.();
        },
        dispose() {
          try {
            captions.dispose();
          } finally {
            agent.dispose();
          }
        },
        currentResponseId: () => agent.currentResponseId?.(),
        interruptResponse: (responseId, signal) =>
          agent.interruptResponse?.(responseId, signal) ??
          Promise.resolve(false),
        redirectResponse: (responseId, instructions, signal) =>
          agent.redirectResponse?.(responseId, instructions, signal) ??
          Promise.resolve(false),
      };
    },
  };
}
