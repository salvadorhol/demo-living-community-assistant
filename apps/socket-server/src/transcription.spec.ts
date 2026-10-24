import { createLogger } from './logger.ts';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import type { VoiceAgentFactory } from './conversation.ts';
import { withTranscription } from './transcription.ts';
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
function setup() {
  const logs: string[] = [];
  const logger = createLogger(
    { LOG_FORMAT: 'json' },
    { write: (line) => logs.push(String(line)) },
  );
  const upstream = new Upstream();
  let context: Parameters<VoiceAgentFactory['create']>[0];
  const voice = {
    initialize: vi.fn(async () => undefined),
    beginInput: vi.fn(),
    write: vi.fn(),
    pause: vi.fn(),
    progress: vi.fn(),
    dispose: vi.fn(),
  };
  const create = vi.fn<VoiceAgentFactory['create']>((value) => {
    context = value;
    return voice;
  });
  const transcript = vi.fn();
  const degraded = vi.fn();
  const factory = withTranscription(
    { kind: 'conversation', create },
    'test-key',
    () => upstream as unknown as WebSocket,
  );
  const agent = factory.create({
    uid: 'owner',
    logger,
    output: vi.fn(),
    transcript,
    degraded,
  });
  async function initialize() {
    const ready = agent.initialize();
    await Promise.resolve();
    upstream.emit('open');
    upstream.event({ type: 'session.updated' });
    await ready;
  }
  return {
    upstream,
    logs,
    agent,
    voice,
    transcript,
    degraded,
    initialize,
    turnEnd: () => context.turnEnded?.(),
  };
}
it('streams user partials before committing, commits on voice turn boundaries, and keeps ASR separate', async () => {
  const f = setup();
  await f.initialize();
  f.agent.beginInput();
  f.agent.write(new Uint8Array(4800));
  expect(f.upstream.sent[0]).toMatchObject({
    session: {
      type: 'transcription',
      audio: {
        input: {
          transcription: { model: 'gpt-live-transcribe' },
          turn_detection: null,
        },
      },
    },
  });
  f.upstream.event({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'one',
    content_index: 0,
    delta: 'Hel',
  });
  expect(f.transcript).toHaveBeenLastCalledWith({
    id: 'user-one-0',
    role: 'user',
    text: 'Hel',
    isFinal: false,
  });
  f.turnEnd();
  expect(f.upstream.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
  f.upstream.event({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'one',
    content_index: 0,
    transcript: 'Hello',
  });
  expect(f.transcript).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: 'Hello', isFinal: true }),
  );
  f.agent.pause();
  f.agent.beginInput();
  expect(f.voice.beginInput).toHaveBeenCalledTimes(2);
  f.agent.dispose();
  const calls = f.transcript.mock.calls.length;
  f.upstream.event({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: 'late',
    content_index: 0,
    delta: 'late',
  });
  expect(f.transcript).toHaveBeenCalledTimes(calls);
});
it('degrades transcription without taking down voice and bounds ASR backlog', async () => {
  const f = setup();
  await f.initialize();
  f.upstream.bufferedAmount = 100000;
  f.agent.write(new Uint8Array(4800));
  expect(f.degraded).toHaveBeenCalled();
  expect(f.logs.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      event: 'transcription.degraded',
      err: expect.objectContaining({
        message: 'Transcription input backlog exceeded',
      }),
    }),
  );
  f.agent.write(new Uint8Array(4800));
  expect(f.voice.write).toHaveBeenCalledTimes(2);
  expect(f.voice.dispose).not.toHaveBeenCalled();
  f.agent.dispose();
});

it('logs transcription configuration rejection while keeping voice available', async () => {
  const f = setup();
  const starting = f.agent.initialize();
  await Promise.resolve();
  f.upstream.emit('open');
  f.upstream.event({
    type: 'error',
    error: {
      type: 'invalid_request_error',
      code: 'invalid_value',
      param: 'session.audio.input.transcription.model',
      message: 'private provider payload',
    },
  });
  await expect(starting).resolves.toBeUndefined();
  expect(f.degraded).toHaveBeenCalledOnce();
  expect(f.voice.dispose).not.toHaveBeenCalled();
  expect(() => f.agent.write(new Uint8Array(1920))).not.toThrow();
  expect(f.logs.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      event: 'transcription.configuration_failed',
      err: expect.objectContaining({ type: 'ConfigurationError' }),
    }),
  );
  expect(f.logs.join('')).not.toContain('private provider payload');
  f.agent.dispose();
});
