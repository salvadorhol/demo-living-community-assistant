import { loadTestPrompt } from '../testing/prompt-fixture.ts';
import { createConversationSession } from './session.ts';
import { createVoiceAgent } from '../ai/create-agent.ts';
import { createRealtimeVoice } from '../ai/openai/realtime-session.ts';
import { createTranscriptionSession } from '../ai/openai/transcription-session.ts';
import { createFakeOpenAI } from '../testing/fake-openai.ts';

it('redirects through the real adapters without a new call or observer lifecycle', async () => {
  const upstream = await createFakeOpenAI();
  const results: boolean[] = [];
  const statuses: { callId: string; state: string }[] = [];
  const observerDisposed = vi.fn();
  const published = vi.fn();
  let requested = false;
  const session = createConversationSession({
    uid: 'owner',
    roomId: 'room',
    factory: createVoiceAgent({
      voice: createRealtimeVoice('fixture-key', upstream.connect, {
        loadPrompt: loadTestPrompt,
      }),
      transcription: (context) =>
        createTranscriptionSession(context, 'fixture-key', upstream.connect),
    }),
    events: {
      output: vi.fn(),
      status: (status) => statuses.push(status),
      transcript: published,
    },
    observerFactory: () => ({
      async onTranscript(snapshot, context) {
        if (requested || snapshot.role !== 'assistant' || snapshot.interrupted)
          return;
        requested = true;
        results.push(
          await context.redirectResponse(
            context.target,
            'Answer briefly and stay within scope.',
          ),
        );
      },
      dispose: observerDisposed,
    }),
  });
  try {
    expect(
      await session.start({
        streamId: 'input',
        format: { encoding: 'pcm16le', channels: 1, sampleRate: 24000 },
      }),
    ).toEqual({ ok: true });
    expect(
      session.write({
        streamId: 'input',
        sequence: 0,
        data: new Uint8Array(4800),
      }),
    ).toEqual({ ok: true });
    await vi.waitFor(() => expect(results).toEqual([true]), { timeout: 5000 });
    const assistantIds = new Set(
      published.mock.calls
        .map(([value]) => value)
        .filter((value) => value.role === 'assistant')
        .map((value) => value.id),
    );
    expect(assistantIds.size).toBe(2);
    expect(new Set(statuses.map((status) => status.callId)).size).toBe(1);
    expect(
      statuses.some(
        (status) => status.state === 'saved' || status.state === 'failed',
      ),
    ).toBe(false);
    expect(observerDisposed).not.toHaveBeenCalled();
    expect(
      session.write({
        streamId: 'input',
        sequence: 1,
        data: new Uint8Array(1920),
      }),
    ).toEqual({ ok: true });
  } finally {
    await session.close();
    await upstream.close();
  }
  expect(observerDisposed).toHaveBeenCalledOnce();
});
