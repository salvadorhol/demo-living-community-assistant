import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { AudioOutputEvent } from '@living-community-assistant/types';
import { createOpenAIAudio } from './openai-audio.ts';
import { AGENT_CONFIG } from './agent-config.ts';

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
function setup(key: string | undefined = 'test-key') {
  const upstream = new Upstream();
  const connect = vi.fn(() => upstream as unknown as WebSocket);
  const events: AudioOutputEvent[] = [];
  const factory = createOpenAIAudio(key, connect);
  const agent = factory.create({
    uid: 'private-user',
    output: (event) => events.push(event),
  });
  const initialize = async () => {
    const ready = agent.initialize();
    upstream.emit('open');
    upstream.event({ type: 'session.updated' });
    await ready;
    agent.beginInput();
  };
  return { upstream, connect, events, agent, initialize };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('centralizes models and accepts the legacy key only as a fallback', () => {
  expect(AGENT_CONFIG.model).toBe('gpt-realtime-2.1-mini');
  expect(AGENT_CONFIG.transcriptionModel).toBe('gpt-live-transcribe');
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
    expect.stringContaining(AGENT_CONFIG.model),
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
      instructions: AGENT_CONFIG.instructions,
      audio: { input: { turn_detection: null }, output: { voice: 'marin' } },
    },
  });
  upstream.event({ type: 'session.updated' });
  await pending;
  agent.beginInput();
  expect(upstream.sent.at(-1)).toMatchObject({
    session: {
      audio: { input: { turn_detection: AGENT_CONFIG.turnDetection } },
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
    const { agent, upstream, events } = setup();
    const pending = expect(agent.initialize()).rejects.toThrow();
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(10_001);
    else if (failure === 'invalid-json')
      upstream.emit('message', Buffer.from('broken'));
    else upstream.emit(failure, new Error('secret provider details'));
    await pending;
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
  upstream.bufferedAmount = AGENT_CONFIG.maxQueuedBytes + 1;
  expect(() => agent.write(new Uint8Array(1920))).toThrow('backlog');
  agent.dispose();
});
