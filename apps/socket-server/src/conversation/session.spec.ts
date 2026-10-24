import { createConversationSession } from './session.ts';
import { createLogger } from '../logger.ts';
import type { VoiceAgentFactory } from '../ai/contracts.ts';
import type {
  TranscriptContext,
  TranscriptObserverFactory,
  TranscriptSnapshot,
} from './transcript-observer.ts';

const stream = (streamId = 'microphone') => ({
  streamId,
  format: { encoding: 'pcm16le', sampleRate: 24000, channels: 1 } as const,
});
function fixture(observerFactory?: TranscriptObserverFactory) {
  let provider!: Parameters<VoiceAgentFactory['create']>[0];
  let responseId: string | undefined;
  const logs: string[] = [];
  const agent = {
    initialize: vi.fn(async () => undefined),
    beginInput: vi.fn(),
    write: vi.fn(),
    pause: vi.fn(),
    dispose: vi.fn(),
    progress: vi.fn(),
    currentResponseId: () => responseId,
    interruptResponse: vi.fn(async () => true),
    redirectResponse: vi.fn(async () => true),
  };
  const events = { output: vi.fn(), status: vi.fn(), transcript: vi.fn() };
  const session = createConversationSession({
    uid: 'user',
    roomId: 'room',
    observerFactory,
    events,
    logger: createLogger(
      { LOG_FORMAT: 'json' },
      { write: (line) => logs.push(String(line)) },
    ),
    factory: {
      kind: 'conversation',
      metadata: { model: 'test-model' },
      create(context) {
        provider = context;
        return agent;
      },
    },
  });
  return {
    session,
    events,
    agent,
    logs,
    provider: () => provider,
    response(id: string) {
      responseId = id;
      provider.responseStarted?.(id);
    },
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

it('publishes immutable user/assistant snapshots with revisions and internal provider identity', async () => {
  const received: TranscriptSnapshot[] = [];
  const f = fixture(() => ({
    onTranscript(snapshot) {
      received.push(snapshot);
    },
  }));
  try {
    expect(await f.session.start(stream())).toEqual({ ok: true });
    f.response('reply');
    f.provider().transcript?.({
      id: 'user-one',
      role: 'user',
      text: 'Hel',
      isFinal: false,
      source: 'transcription',
      providerItemId: 'asr-one',
    });
    f.provider().transcript?.({
      id: 'user-one',
      role: 'user',
      text: 'Hello',
      isFinal: true,
      source: 'transcription',
      providerItemId: 'asr-one',
    });
    f.provider().transcript?.({
      id: 'assistant-one',
      role: 'assistant',
      text: 'Hi',
      isFinal: true,
      providerItemId: 'voice-one',
      providerResponseId: 'reply',
      source: 'voice',
    });
    await flush();
    expect(received.map((item) => item.revision)).toEqual([1, 2, 1]);
    expect(received[0].createdAt).toBe(received[1].createdAt);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(received[2]).toMatchObject({
      source: 'voice',
      providerResponseId: 'reply',
      providerItemId: 'voice-one',
    });
    const published = f.events.transcript.mock.calls.map(([item]) => item);
    expect(published[2]).not.toHaveProperty('providerResponseId');
    expect(published[0]).not.toHaveProperty('source');
  } finally {
    await f.session.close();
  }
});

it.each(['throw', 'reject', 'factory'] as const)(
  'contains observer %s failures without blocking audio',
  async (mode) => {
    const f = fixture(() => {
      if (mode === 'factory') throw new Error('observer factory failed');
      return {
        onTranscript() {
          if (mode === 'throw') throw new Error('observer failed');
          return Promise.reject(new Error('observer failed'));
        },
      };
    });
    try {
      await f.session.start(stream());
      f.provider().transcript?.({
        id: 'one',
        role: 'user',
        text: 'Hello',
        isFinal: true,
      });
      expect(f.events.transcript).toHaveBeenCalledOnce();
      expect(
        f.session.write({
          streamId: 'microphone',
          sequence: 0,
          data: new Uint8Array(2),
        }),
      ).toEqual({ ok: true });
      await flush();
      expect(f.logs.join('')).toContain('conversation.observer_failed');
      expect(f.agent.dispose).not.toHaveBeenCalled();
    } finally {
      await f.session.close();
    }
  },
);

it.each(['pause', 'end', 'disconnect', 'speech', 'response'] as const)(
  'ignores stale observer controls after %s',
  async (change) => {
    let context!: TranscriptContext;
    const dispose = vi.fn();
    const f = fixture(() => ({
      onTranscript(_snapshot, value) {
        context = value;
      },
      dispose,
    }));
    try {
      await f.session.start(stream());
      f.response('first');
      f.provider().transcript?.({
        id: 'one',
        role: 'assistant',
        text: 'Hello',
        isFinal: false,
        providerResponseId: 'first',
      });
      await flush();
      const signal = context.signal;
      if (change === 'pause') f.session.pause({ streamId: 'microphone' });
      if (change === 'end') f.session.end(context.target.callId);
      if (change === 'disconnect') await f.session.disconnect();
      if (change === 'speech') f.provider().speechStarted?.();
      if (change === 'response') f.response('second');
      expect(signal.aborted).toBe(true);
      expect(await context.interruptResponse(context.target)).toBe(false);
      expect(
        await context.redirectResponse(context.target, 'Stay within scope'),
      ).toBe(false);
      expect(f.agent.interruptResponse).not.toHaveBeenCalled();
      expect(f.agent.redirectResponse).not.toHaveBeenCalled();
    } finally {
      await f.session.close();
      await flush();
      expect(dispose).toHaveBeenCalledOnce();
    }
  },
);

it('lets trusted observers request controls only on their current response', async () => {
  let context!: TranscriptContext;
  const f = fixture(() => ({
    onTranscript(_snapshot, value) {
      context = value;
    },
  }));
  try {
    await f.session.start(stream());
    f.response('current');
    f.provider().transcript?.({
      id: 'one',
      role: 'assistant',
      text: 'Hello',
      isFinal: true,
      providerResponseId: 'current',
    });
    await flush();
    expect(await context.interruptResponse(context.target)).toBe(true);
    expect(
      await context.redirectResponse(context.target, 'Use a shorter answer'),
    ).toBe(true);
    expect(f.agent.redirectResponse).toHaveBeenCalledWith(
      'current',
      'Use a shorter answer',
      context.signal,
    );
    await expect(context.redirectResponse(context.target, '')).rejects.toThrow(
      'Corrective instructions',
    );
  } finally {
    await f.session.close();
  }
});
