import { ASSISTANT_PROFILE } from '../assistant-profile.ts';
import { VOICE_LIMITS } from '../../config.ts';
import { createLogger } from '../../logger.ts';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { AudioOutputEvent } from '@living-community-assistant/types';
import { createRealtimeVoice } from './realtime-session.ts';
import { loadTestPrompt, testPrompt } from '../../testing/prompt-fixture.ts';
import { createSophieTools } from '../tools/sophie.ts';
import { silentLogger } from '../../logger.ts';

class Upstream extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string, callback: (error?: Error) => void) {
    this.sent.push(JSON.parse(value));
    callback();
  }
  terminate = vi.fn(() => this.emit('close'));
  event(value: object) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}
function setup(
  key: string | undefined = 'test-key',
  maxOutputQueueMs?: number,
) {
  const logs: string[] = [];
  const logger = createLogger(
    { LOG_FORMAT: 'json' },
    { write: (line) => logs.push(String(line)) },
  );
  const upstream = new Upstream();
  const connect = vi.fn(() => upstream as unknown as WebSocket);
  const events: AudioOutputEvent[] = [];
  const factory = createRealtimeVoice(key, connect, {
    maxOutputQueueMs,
    loadPrompt: loadTestPrompt,
  });
  const agent = factory.create({
    uid: 'private-user',
    logger,
    output: (event) => events.push(event),
  });
  const initialize = async () => {
    const ready = agent.initialize();
    upstream.emit('open');
    upstream.event({ type: 'session.updated' });
    await ready;
    agent.beginInput();
  };
  return { upstream, connect, events, agent, initialize, logs };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('greets a remembered visitor once, keeps business lookups behind the director attempt, and preserves Pause/Resume', async () => {
  const upstream = new Upstream();
  const registry = createSophieTools(
    { projectId: 'demo-tools', region: 'us-central1' },
    'owner',
    {
      invoke: async (name) =>
        name === 'getContactInformation'
          ? { profile: { firstName: 'James' } }
          : { available: false },
    },
  );
  const agent = createRealtimeVoice(
    'test-key',
    () => upstream as unknown as WebSocket,
    { tools: registry, loadPrompt: loadTestPrompt },
  ).create({ uid: 'owner', output: () => undefined, logger: silentLogger });
  const pending = agent.initialize();
  upstream.emit('open');
  await vi.advanceTimersByTimeAsync(0);
  expect(upstream.sent[0]).toMatchObject({
    session: {
      tool_choice: 'auto',
    },
  });
  expect(registry.definitions.map((t) => t.name)).not.toContain(
    'get_available_appointments',
  );
  upstream.event({ type: 'session.updated' });
  await pending;
  agent.beginInput();
  const greetings = () =>
    upstream.sent.filter((e) => e.type === 'response.create');
  expect(greetings()).toHaveLength(1);
  expect(greetings()[0]).toMatchObject({
    response: {
      tool_choice: 'none',
      instructions: expect.stringContaining('Welcome back, James.'),
    },
  });
  upstream.event({ type: 'response.created', response: { id: 'greeting' } });
  upstream.event({
    type: 'response.done',
    response: { id: 'greeting', status: 'completed' },
  });
  agent.pause();
  agent.beginInput();
  expect(greetings()).toHaveLength(1);
  await registry.execute(
    {
      name: 'check_sales_director_availability',
      arguments: '{}',
      call_id: 'sales',
    },
    {
      uid: 'owner',
      signal: new AbortController().signal,
      logger: silentLogger,
    },
  );
  expect(registry.toolChoice?.()).toBe('auto');
  agent.dispose();
});

it('centralizes models and accepts the legacy key only as a fallback', () => {
  expect(ASSISTANT_PROFILE.model).toBe('gpt-realtime-2.1-mini');
  expect(ASSISTANT_PROFILE.transcriptionModel).toBe('gpt-live-transcribe');
});

it('waits for configuration and keeps credentials and hashed identity server-side', async () => {
  const { agent, upstream, connect } = setup();
  let ready = false;
  const pending = agent.initialize().then(() => {
    ready = true;
  });
  upstream.emit('open');
  upstream.event({ type: 'session.created' });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(connect).toHaveBeenCalledWith(
    expect.stringContaining(ASSISTANT_PROFILE.model),
    {
      headers: {
        Authorization: 'Bearer test-key',
        'OpenAI-Safety-Identifier': expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    },
  );
  expect(upstream.sent[0]).toMatchObject({
    type: 'session.update',
    session: {
      instructions: testPrompt.content,
      audio: { input: { turn_detection: null }, output: { voice: 'marin' } },
    },
  });
  upstream.event({ type: 'session.updated' });
  await pending;
  agent.beginInput();
  expect(upstream.sent.at(-1)).toMatchObject({
    session: {
      audio: { input: { turn_detection: ASSISTANT_PROFILE.turnDetection } },
    },
  });
  agent.dispose();
});

it('streams exact PCM, paces output, and preserves conversation across microphone pauses', async () => {
  const { agent, upstream, initialize, connect, events } = setup();
  await initialize();
  const bytes = Buffer.alloc(6000, 42);
  agent.write(bytes.subarray(0, 1920));
  expect(upstream.sent.at(-1)).toEqual({
    type: 'input_audio_buffer.append',
    audio: bytes.subarray(0, 1920).toString('base64'),
  });
  for (const id of ['first', 'second']) {
    upstream.event({ type: 'response.created', response: { id } });
    upstream.event({
      type: 'response.output_audio.delta',
      response_id: id,
      item_id: id,
      content_index: 0,
      delta: bytes.toString('base64'),
    });
    upstream.event({ type: 'response.output_audio.done', item_id: id });
    upstream.event({
      type: 'response.done',
      response: { id, status: 'completed' },
    });
    await vi.advanceTimersByTimeAsync(200);
    const start = events.filter((event) => event.type === 'start').at(-1);
    expect(start?.type).toBe('start');
    if (start?.type !== 'start') throw new Error('Missing audio');
    const chunks = events.filter(
      (event) =>
        event.type === 'chunk' &&
        event.chunk.streamId === start.stream.streamId,
    );
    expect(
      Buffer.concat(
        chunks.map((event) =>
          event.type === 'chunk'
            ? Buffer.from(event.chunk.data)
            : Buffer.alloc(0),
        ),
      ),
    ).toEqual(bytes);
    expect(
      chunks.map((event) => event.type === 'chunk' && event.chunk.sequence),
    ).toEqual([0, 1, 2, 3]);
    expect(events.at(-1)).toEqual({
      type: 'end',
      streamId: start.stream.streamId,
    });
    agent.progress({ streamId: start.stream.streamId, playedMs: 125 });
    agent.pause();
    agent.progress({
      streamId: start.stream.streamId,
      playedMs: 125,
      cleared: true,
    });
    await agent.initialize();
    agent.beginInput();
  }
  expect(connect).toHaveBeenCalledTimes(1);
  expect(
    upstream.sent.filter((event) => event.type === 'input_audio_buffer.clear'),
  ).toHaveLength(2);
  agent.dispose();
});

it.each([false, true])(
  'truncates unheard audio on interruption after generation finished=%s',
  async (finished) => {
    const { agent, upstream, initialize, events } = setup();
    await initialize();
    upstream.event({ type: 'response.created', response: { id: 'r' } });
    upstream.event({
      type: 'response.output_audio.delta',
      response_id: 'r',
      item_id: 'item',
      content_index: 0,
      delta: Buffer.alloc(19200).toString('base64'),
    });
    if (finished)
      upstream.event({
        type: 'response.done',
        response: { id: 'r', status: 'completed' },
      });
    const start = events[0];
    if (start.type !== 'start') throw new Error('Missing audio');
    agent.progress({ streamId: start.stream.streamId, playedMs: 40 });
    upstream.event({ type: 'input_audio_buffer.speech_started' });
    agent.progress({ streamId: 'another-socket', playedMs: 100 });
    agent.progress({
      streamId: start.stream.streamId,
      playedMs: 80,
      cleared: true,
    });
    expect(upstream.sent.at(-1)).toEqual({
      type: 'conversation.item.truncate',
      item_id: 'item',
      content_index: 0,
      audio_end_ms: 80,
    });
    expect(
      upstream.sent.some((event) => event.type === 'response.cancel'),
    ).toBe(!finished);
    expect(events.at(-1)).toEqual({
      type: 'clear',
      streamId: start.stream.streamId,
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(events.filter((event) => event.type === 'chunk')).toHaveLength(0);
    agent.dispose();
  },
);

it('ignores late audio after Stop and truncates from the last report if feedback is lost', async () => {
  const { agent, upstream, initialize, events } = setup();
  await initialize();
  upstream.event({
    type: 'response.output_audio.delta',
    response_id: 'r',
    item_id: 'item',
    content_index: 0,
    delta: Buffer.alloc(1920).toString('base64'),
  });
  agent.pause();
  const count = events.length;
  upstream.event({
    type: 'response.output_audio.delta',
    response_id: 'r',
    item_id: 'item',
    content_index: 0,
    delta: Buffer.alloc(1920).toString('base64'),
  });
  await vi.advanceTimersByTimeAsync(300);
  expect(events).toHaveLength(count);
  expect(upstream.sent.at(-1)).toMatchObject({
    type: 'conversation.item.truncate',
    audio_end_ms: 0,
  });
  agent.dispose();
});

it.each(['error', 'close', 'timeout', 'invalid-json'])(
  'surfaces sanitized %s and rejects pending setup',
  async (failure) => {
    const { agent, upstream, events, logs } = setup();
    const pending = expect(agent.initialize()).rejects.toThrow();
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
    else if (failure === 'invalid-json')
      upstream.emit('message', Buffer.from('broken'));
    else upstream.emit(failure, new Error('secret provider details'));
    await pending;
    expect(
      logs
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'voice.provider_failed'),
    ).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'VOICE_UNAVAILABLE' },
    });
    expect(JSON.stringify(events)).not.toContain('secret');
    const count = events.length;
    agent.dispose();
    upstream.event({ type: 'session.updated' });
    expect(events).toHaveLength(count);
    expect(upstream.terminate).toHaveBeenCalledTimes(1);
  },
);

it('rejects missing credentials and bounds upstream backpressure', async () => {
  const missing = setup('');
  await expect(missing.agent.initialize()).rejects.toThrow('OPENAI_API_KEY');
  expect(missing.connect).not.toHaveBeenCalled();
  missing.agent.dispose();
  const { agent, upstream, initialize } = setup();
  await initialize();
  upstream.bufferedAmount = VOICE_LIMITS.maxQueuedBytes + 1;
  expect(() => agent.write(new Uint8Array(1920))).toThrow('backlog');
  agent.dispose();
});

it('accepts a normal 20-second generation burst above the previous 10-second cap and paces output', async () => {
  const f = setup();
  await f.initialize();
  f.upstream.event({ type: 'response.created', response: { id: 'burst' } });
  f.upstream.event({
    type: 'response.output_audio.delta',
    response_id: 'burst',
    item_id: 'burst',
    content_index: 0,
    delta: Buffer.alloc(20 * 48000).toString('base64'),
  });
  expect(
    f.events.filter(
      (event) => event.type === 'error' || event.type === 'warning',
    ),
  ).toHaveLength(0);
  expect(f.upstream.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(80);
  const chunks = f.events.filter((event) => event.type === 'chunk');
  expect(chunks).toHaveLength(2);
  for (const event of chunks)
    if (event.type === 'chunk') expect(event.chunk.data.byteLength).toBe(1920);
  f.agent.dispose();
});

it.each([false, true])(
  'cancels an oversized reply without ending the session (generation finished=%s)',
  async (finished) => {
    const f = setup('test-key', 1000);
    await f.initialize();
    f.upstream.event({ type: 'response.created', response: { id: 'long' } });
    const delta = (bytes: number, id = 'long') => ({
      type: 'response.output_audio.delta',
      response_id: id,
      item_id: id,
      content_index: 0,
      delta: Buffer.alloc(bytes).toString('base64'),
    });
    f.upstream.event(delta(48000));
    await vi.advanceTimersByTimeAsync(40);
    if (finished)
      f.upstream.event({
        type: 'response.done',
        response: { id: 'long', status: 'completed' },
      });
    f.upstream.event(delta(4800));
    expect(f.events.at(-1)).toMatchObject({
      type: 'warning',
      warning: { code: 'VOICE_OUTPUT_LIMIT' },
    });
    expect(f.events.some((event) => event.type === 'clear')).toBe(true);
    expect(f.events.some((event) => event.type === 'error')).toBe(false);
    expect(f.upstream.terminate).not.toHaveBeenCalled();
    expect(
      f.upstream.sent.some((event) => event.type === 'response.cancel'),
    ).toBe(!finished);
    const eventCount = f.events.length;
    f.upstream.event(delta(4800));
    expect(f.events).toHaveLength(eventCount);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.upstream.sent).toContainEqual(
      expect.objectContaining({
        type: 'conversation.item.truncate',
        item_id: 'long',
      }),
    );
    expect(() => f.agent.write(new Uint8Array(1920))).not.toThrow();
    f.upstream.event({ type: 'response.created', response: { id: 'next' } });
    f.upstream.event(delta(1920, 'next'));
    await vi.advanceTimersByTimeAsync(40);
    expect(f.events.at(-1)?.type).toBe('chunk');
    expect(f.logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: 'voice.output_limit',
        limitMs: 1000,
        queuedMs: 960,
        incomingBytes: 4800,
      }),
    );
    f.agent.dispose();
  },
);

it('rejects queue configuration before opening a connection', () => {
  expect(() =>
    createRealtimeVoice('key', vi.fn(), { maxOutputQueueMs: -1 }),
  ).toThrow(/VOICE_OUTPUT_QUEUE_MS/);
});

it.each([false, true])(
  'surfaces session configuration rejection before/after initialization=%s',
  async (initialized) => {
    const f = setup();
    const pending = f.agent.initialize();
    f.upstream.emit('open');
    if (initialized) {
      f.upstream.event({ type: 'session.updated' });
      await pending;
      f.agent.beginInput();
    }
    const command = f.upstream.sent.at(-1);
    const rejection = initialized
      ? undefined
      : expect(pending).rejects.toMatchObject({ name: 'ConfigurationError' });
    f.upstream.event({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'invalid_value',
        param: 'session.audio.output.voice',
        event_id: command?.event_id,
        message: 'secret provider payload',
      },
    });
    await rejection;
    expect(f.events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'VOICE_CONFIGURATION_ERROR',
        message: expect.stringContaining('administrator'),
      },
    });
    expect(JSON.stringify(f.events)).not.toContain('secret');
    expect(f.logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({
        event: 'voice.configuration_rejected',
        providerCode: 'invalid_value',
        parameter: 'session.audio.output.voice',
      }),
    );
    f.agent.dispose();
  },
);

function controls(f: ReturnType<typeof setup>) {
  const { redirectResponse, interruptResponse } = f.agent;
  if (!redirectResponse || !interruptResponse)
    throw new Error('Expected controllable voice provider');
  return { redirectResponse, interruptResponse };
}

function reply(f: ReturnType<typeof setup>, id = 'controlled') {
  f.upstream.event({ type: 'response.created', response: { id } });
  f.upstream.event({
    type: 'response.output_audio.delta',
    response_id: id,
    item_id: id,
    content_index: 0,
    delta: Buffer.alloc(9600).toString('base64'),
  });
}
const flushControls = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it('waits for cancellation and truncation before creating one corrective reply', async () => {
  const f = setup();
  await f.initialize();
  reply(f);
  const result = controls(f).redirectResponse(
    'controlled',
    'Give a brief answer within community scope.',
    new AbortController().signal,
  );
  await flushControls();
  expect(f.upstream.sent).toContainEqual({
    type: 'response.cancel',
    response_id: 'controlled',
  });
  expect(f.events.at(-1)?.type).toBe('clear');
  expect(
    f.upstream.sent.some((event) => event.type === 'response.create'),
  ).toBe(false);
  f.upstream.event({
    type: 'response.done',
    response: { id: 'controlled', status: 'cancelled' },
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(f.upstream.sent.at(-1)).toMatchObject({
    type: 'conversation.item.truncate',
    item_id: 'controlled',
  });
  expect(
    f.upstream.sent.some((event) => event.type === 'response.create'),
  ).toBe(false);
  f.upstream.event({
    type: 'conversation.item.truncated',
    item_id: 'controlled',
    content_index: 0,
  });
  await flushControls();
  const requests = f.upstream.sent.filter(
    (event) => event.type === 'response.create',
  );
  expect(requests).toHaveLength(1);
  const response = requests[0].response as {
    instructions: string;
    metadata: Record<string, string>;
  };
  expect(response.instructions).toContain(testPrompt.content);
  expect(response.instructions).toContain(
    'Give a brief answer within community scope.',
  );
  f.upstream.event({
    type: 'response.created',
    response: { id: 'replacement', metadata: response.metadata },
  });
  expect(await result).toBe(true);
  expect(f.agent.currentResponseId?.()).toBe('replacement');
  expect(
    f.upstream.sent
      .filter((event) => event.type === 'session.update')
      .some((event) => JSON.stringify(event).includes('Give a brief answer')),
  ).toBe(false);
  f.agent.dispose();
});

it('can interrupt already-generated audio while leaving the conversation open', async () => {
  const f = setup();
  await f.initialize();
  reply(f);
  f.upstream.event({
    type: 'response.output_audio.done',
    item_id: 'controlled',
  });
  f.upstream.event({
    type: 'response.done',
    response: { id: 'controlled', status: 'completed' },
  });
  const result = controls(f).interruptResponse(
    'controlled',
    new AbortController().signal,
  );
  await flushControls();
  await vi.advanceTimersByTimeAsync(250);
  f.upstream.event({
    type: 'conversation.item.truncated',
    item_id: 'controlled',
    content_index: 0,
  });
  expect(await result).toBe(true);
  expect(
    f.upstream.sent.some((event) => event.type === 'response.cancel'),
  ).toBe(false);
  expect(f.upstream.terminate).not.toHaveBeenCalled();
  expect(
    await controls(f).interruptResponse(
      'controlled',
      new AbortController().signal,
    ),
  ).toBe(false);
  f.agent.dispose();
});

it.each([
  'signal',
  'before-send',
  'speech',
  'response',
  'pause',
  'dispose',
] as const)(
  'abandons pending redirection on %s without reviving speech',
  async (action) => {
    const f = setup();
    await f.initialize();
    reply(f);
    const owner = new AbortController();
    const result = controls(f).redirectResponse(
      'controlled',
      'Stay on topic',
      owner.signal,
    );
    if (action === 'before-send') owner.abort();
    await flushControls();
    if (action === 'signal') owner.abort();
    if (action === 'speech')
      f.upstream.event({ type: 'input_audio_buffer.speech_started' });
    if (action === 'response')
      f.upstream.event({
        type: 'response.created',
        response: { id: 'superseding' },
      });
    if (action === 'pause') f.agent.pause();
    if (action === 'dispose') f.agent.dispose();
    expect(await result).toBe(false);
    f.upstream.event({
      type: 'response.done',
      response: { id: 'controlled', status: 'cancelled' },
    });
    await vi.advanceTimersByTimeAsync(250);
    f.upstream.event({
      type: 'conversation.item.truncated',
      item_id: 'controlled',
      content_index: 0,
    });
    expect(
      f.upstream.sent.some((event) => event.type === 'response.create'),
    ).toBe(false);
    f.agent.dispose();
  },
);

it('bounds control acknowledgements and surfaces timeout as a provider failure', async () => {
  const f = setup();
  await f.initialize();
  reply(f);
  const result = controls(f).redirectResponse(
    'controlled',
    'Stay on topic',
    new AbortController().signal,
  );
  await flushControls();
  await vi.advanceTimersByTimeAsync(2001);
  expect(await result).toBe(false);
  expect(f.events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'VOICE_UNAVAILABLE' },
  });
  expect(
    f.upstream.sent.some((event) => event.type === 'response.create'),
  ).toBe(false);
  f.agent.dispose();
});

it('loads a fresh prompt for each call and keeps an active call snapshot', async () => {
  const upstreams: Upstream[] = [];
  let revision = 1;
  const loadPrompt = vi.fn(async () => ({
    ...testPrompt,
    content: `Private instructions ${revision}`,
    revision,
  }));
  const connect = vi.fn(() => {
    const upstream = new Upstream();
    upstreams.push(upstream);
    return upstream as unknown as WebSocket;
  });
  const factory = createRealtimeVoice('key', connect, { loadPrompt });
  const metadata = vi.fn();
  const first = factory.create({ uid: 'owner', output: vi.fn(), metadata });
  const pending = first.initialize();
  expect(connect).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  upstreams[0].emit('open');
  upstreams[0].event({ type: 'session.updated' });
  await pending;
  expect(upstreams[0].sent[0]).toMatchObject({
    session: { instructions: 'Private instructions 1' },
  });
  expect(metadata).toHaveBeenCalledWith({ sophiePromptRevision: '1' });
  revision = 2;
  first.beginInput();
  first.pause();
  await first.initialize();
  first.beginInput();
  expect(loadPrompt).toHaveBeenCalledTimes(1);
  const second = factory.create({ uid: 'owner', output: vi.fn() });
  const next = second.initialize();
  await vi.advanceTimersByTimeAsync(0);
  upstreams[1].emit('open');
  upstreams[1].event({ type: 'session.updated' });
  await next;
  expect(upstreams[1].sent[0]).toMatchObject({
    session: { instructions: 'Private instructions 2' },
  });
  first.dispose();
  second.dispose();
});

it.each([
  undefined,
  { ...testPrompt, content: '  ' },
  { ...testPrompt, revision: 0 },
])(
  'blocks invalid or missing prompt data before opening upstream',
  async (value) => {
    const connect = vi.fn();
    const agent = createRealtimeVoice('key', connect, {
      loadPrompt: () => value as typeof testPrompt,
    }).create({ uid: 'owner', output: vi.fn() });
    await expect(agent.initialize()).rejects.toThrow('prompt');
    expect(connect).not.toHaveBeenCalled();
  },
);
it('bounds prompt reads and ignores a late result after timeout', async () => {
  let complete!: (value: typeof testPrompt) => void;
  const connect = vi.fn();
  const agent = createRealtimeVoice('key', connect, {
    loadPrompt: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  }).create({ uid: 'owner', output: vi.fn() });
  const rejected = expect(agent.initialize()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  complete(testPrompt);
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).not.toHaveBeenCalled();
});
it('does not open upstream after disposal during a prompt read', async () => {
  let complete!: (value: typeof testPrompt) => void;
  const connect = vi.fn();
  const agent = createRealtimeVoice('key', connect, {
    loadPrompt: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  }).create({ uid: 'owner', output: vi.fn() });
  const rejected = expect(agent.initialize()).rejects.toThrow();
  agent.dispose();
  await rejected;
  complete(testPrompt);
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).not.toHaveBeenCalled();
});
