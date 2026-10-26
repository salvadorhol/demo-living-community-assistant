import {loadTestPrompt} from '../testing/prompt-fixture.ts';
import {createConversationSession} from './session.ts';
import {createVoiceAgent} from '../ai/create-agent.ts';
import {createRealtimeVoice} from '../ai/openai/realtime-session.ts';
import {createTranscriptionSession} from '../ai/openai/transcription-session.ts';
import {createFakeOpenAI} from '../testing/fake-openai.ts';

it('redirects through the real adapters without a new call or observer lifecycle', async () => {
  const upstream = await createFakeOpenAI();
  const results: boolean[] = [];
  const statuses: {callId: string; state: string}[] = [];
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
      transcription: context =>
        createTranscriptionSession(context, 'fixture-key', upstream.connect),
    }),
    events: {
      output: vi.fn(),
      status: status => statuses.push(status),
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
            'Answer briefly and stay within scope.'
          )
        );
      },
      dispose: observerDisposed,
    }),
  });
  try {
    expect(
      await session.start({
        streamId: 'input',
        format: {encoding: 'pcm16le', channels: 1, sampleRate: 24000},
      })
    ).toEqual({ok: true});
    expect(
      session.write({
        streamId: 'input',
        sequence: 0,
        data: new Uint8Array(4800),
      })
    ).toEqual({ok: true});
    await vi.waitFor(() => expect(results).toEqual([true]), {timeout: 5000});
    const assistantIds = new Set(
      published.mock.calls
        .map(([value]) => value)
        .filter(value => value.role === 'assistant')
        .map(value => value.id)
    );
    expect(assistantIds.size).toBe(2);
    expect(new Set(statuses.map(status => status.callId)).size).toBe(1);
    expect(
      statuses.some(
        status => status.state === 'saved' || status.state === 'failed'
      )
    ).toBe(false);
    expect(observerDisposed).not.toHaveBeenCalled();
    expect(
      session.write({
        streamId: 'input',
        sequence: 1,
        data: new Uint8Array(1920),
      })
    ).toEqual({ok: true});
  } finally {
    await session.close();
    await upstream.close();
  }
  expect(observerDisposed).toHaveBeenCalledOnce();
});

it('runs a manager handoff through the real voice and ASR adapters after the microphone is paused', async () => {
  const upstream = await createFakeOpenAI();
  const statuses: {state: string; endReason?: string}[] = [];
  const transcript = vi.fn();
  let manager = false;
  const bytes = new Map<string, number>();
  const session = createConversationSession({
    uid: 'owner',
    roomId: 'room',
    guardrail: {
      threshold: 0.8,
      frustrationThreshold: 0.8,
      timeoutMs: 2000,
      check: vi.fn(async () => ({
        promptInjectionProbability: 0,
        frustrationProbability: 1,
        language: 'es' as const,
      })),
    },
    factory: createVoiceAgent({
      voice: createRealtimeVoice('fixture-key', upstream.connect, {
        loadPrompt: loadTestPrompt,
      }),
      transcription: context =>
        createTranscriptionSession(context, 'fixture-key', upstream.connect),
    }),
    events: {
      transcript,
      status: value => statuses.push(value),
      output: event => {
        if (event.type === 'closing' && event.reason === 'demo_manager_handoff')
          manager = true;
        if (event.type === 'chunk')
          bytes.set(
            event.chunk.streamId,
            (bytes.get(event.chunk.streamId) ?? 0) + event.chunk.data.byteLength
          );
        if (manager && event.type === 'end')
          session.progress({
            streamId: event.streamId,
            playedMs: (bytes.get(event.streamId) ?? 0) / 48,
          });
      },
    },
  });
  try {
    expect(
      await session.start({
        streamId: 'input',
        format: {encoding: 'pcm16le', channels: 1, sampleRate: 24000},
      })
    ).toEqual({ok: true});
    session.write({streamId: 'input', sequence: 0, data: new Uint8Array(4800)});
    session.pause({streamId: 'input'});
    await vi.waitFor(
      () =>
        expect(statuses).toContainEqual(
          expect.objectContaining({
            state: 'saved',
            endReason: 'demo_manager_handoff',
          })
        ),
      {timeout: 5000}
    );
    expect(
      transcript.mock.calls.some(
        ([value]) =>
          value.role === 'assistant' &&
          value.text.includes('simulará la transferencia a un gerente')
      )
    ).toBe(true);
  } finally {
    await session.close();
    await upstream.close();
  }
});
