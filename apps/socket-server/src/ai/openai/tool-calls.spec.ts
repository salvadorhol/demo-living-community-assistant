import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { createRealtimeVoice } from './realtime-session.ts';
import { createToolRegistry } from '../tools/registry.ts';
import { isEmptyArguments } from '../tools/contracts.ts';
class Upstream extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  send(value: string, callback: (error?: Error) => void) {
    this.sent.push(JSON.parse(value));
    callback();
  }
  terminate = vi.fn();
  event(value: object) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
}
async function setup(
  execute: (
    args: Record<string, unknown>,
    context: { signal: AbortSignal },
  ) => Promise<unknown> = async () => ({ mock: true }),
) {
  const upstream = new Upstream();
  const output = vi.fn();
  const registry = createToolRegistry([
    {
      name: 'lookup',
      description: 'Look up sample data',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      validateArguments: isEmptyArguments,
      execute,
    },
  ]);
  const agent = createRealtimeVoice(
    'key',
    () => upstream as unknown as WebSocket,
    { tools: registry },
  ).create({ uid: 'owner', output });
  const ready = agent.initialize();
  upstream.emit('open');
  upstream.event({ type: 'session.updated' });
  await ready;
  agent.beginInput();
  function completed(
    id = 'parent',
    calls = [
      { type: 'function_call', call_id: id, name: 'lookup', arguments: '{}' },
    ],
    status = 'completed',
  ) {
    upstream.event({ type: 'response.created', response: { id } });
    upstream.event({
      type: 'response.done',
      response: { id, status, output: calls },
    });
  }
  return { upstream, output, agent, completed };
}
const settle = async () => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
const outputs = (f: Awaited<ReturnType<typeof setup>>) =>
  f.upstream.sent.filter((event) => event.type === 'conversation.item.create');
const continuations = (f: Awaited<ReturnType<typeof setup>>) =>
  f.upstream.sent.filter((event) => event.type === 'response.create');
it('registers definitions and returns tool results before requesting one continuation', async () => {
  const execute = vi.fn(async () => ({ mock: true }));
  const f = await setup(execute);
  f.completed();
  await settle();
  expect(f.upstream.sent[0]).toMatchObject({
    session: { tool_choice: 'auto', tools: [{ name: 'lookup' }] },
  });
  expect(outputs(f)).toHaveLength(1);
  expect(JSON.parse((outputs(f)[0].item as { output: string }).output)).toEqual(
    { ok: true, result: { mock: true } },
  );
  expect(continuations(f)).toHaveLength(1);
  expect(execute).toHaveBeenCalledOnce();
  // A replayed completion must not invoke HTTP or produce another result.
  f.upstream.event({
    type: 'response.done',
    response: {
      id: 'parent',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          call_id: 'parent',
          name: 'lookup',
          arguments: '{}',
        },
      ],
    },
  });
  await settle();
  expect(execute).toHaveBeenCalledOnce();
  expect(continuations(f)).toHaveLength(1);
  f.agent.dispose();
});
it('handles multiple tool calls with at most two concurrent bindings', async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const f = await setup(
    () =>
      new Promise((resolve) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve({ mock: true });
        });
      }),
  );
  f.completed(
    'batch',
    Array.from({ length: 3 }, (_, index) => ({
      type: 'function_call',
      call_id: String(index),
      name: 'lookup',
      arguments: '{}',
    })),
  );
  await settle();
  expect(releases).toHaveLength(2);
  releases[0]();
  await settle();
  expect(releases).toHaveLength(3);
  releases[1]();
  releases[2]();
  await settle();
  expect(peak).toBe(2);
  expect(outputs(f)).toHaveLength(3);
  expect(continuations(f)).toHaveLength(1);
  f.agent.dispose();
});
it('returns budget errors and disables further tool selection', async () => {
  const execute = vi.fn(async () => ({ mock: true }));
  const f = await setup(execute);
  f.completed(
    'budget',
    Array.from({ length: 6 }, (_, index) => ({
      type: 'function_call',
      call_id: String(index),
      name: 'lookup',
      arguments: '{}',
    })),
  );
  await settle();
  expect(execute).toHaveBeenCalledTimes(4);
  expect(outputs(f)).toHaveLength(6);
  expect(continuations(f)[0]).toMatchObject({
    response: { tool_choice: 'none' },
  });
  expect(
    JSON.parse((outputs(f)[5].item as { output: string }).output),
  ).toMatchObject({ error: { code: 'TOOL_BUDGET_EXCEEDED' } });
  f.agent.dispose();
});
it.each(['pause', 'speech', 'dispose', 'replacement'] as const)(
  'aborts pending work and ignores late results after %s',
  async (action) => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    const f = await setup((_args, context) => {
      signal = context.signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    f.completed();
    await settle();
    if (action === 'pause') f.agent.pause();
    if (action === 'speech')
      f.upstream.event({ type: 'input_audio_buffer.speech_started' });
    if (action === 'dispose') f.agent.dispose();
    if (action === 'replacement')
      f.upstream.event({ type: 'response.created', response: { id: 'new' } });
    expect(signal.aborted).toBe(true);
    finish({ mock: true });
    await settle();
    expect(outputs(f)).toHaveLength(0);
    expect(continuations(f)).toHaveLength(0);
    f.agent.dispose();
  },
);
it('ignores incomplete/cancelled calls and returns safe errors without ending voice', async () => {
  const execute = vi.fn(async () => ({ mock: true }));
  const f = await setup(execute);
  f.upstream.event({
    type: 'response.function_call_arguments.done',
    name: 'lookup',
    call_id: 'partial',
    arguments: '{}',
  });
  f.completed('cancelled', undefined, 'cancelled');
  await settle();
  expect(execute).not.toHaveBeenCalled();
  f.completed('bad', [
    {
      type: 'function_call',
      call_id: 'bad',
      name: 'lookup',
      arguments: '{"url":"untrusted"}',
    },
  ]);
  await settle();
  expect(execute).not.toHaveBeenCalled();
  expect(
    JSON.parse((outputs(f)[0].item as { output: string }).output),
  ).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } });
  expect(f.output).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error' }),
  );
  expect(() => f.agent.write(new Uint8Array(2))).not.toThrow();
  f.agent.dispose();
});
it('cancels a late tool continuation that arrives after pause/resume', async () => {
  const f = await setup();
  f.completed();
  await settle();
  const continuation = continuations(f)[0].response as {
    metadata: Record<string, string>;
  };
  f.agent.pause();
  f.agent.beginInput();
  f.upstream.event({
    type: 'response.created',
    response: { id: 'late', metadata: continuation.metadata },
  });
  expect(f.upstream.sent.at(-1)).toEqual({
    type: 'response.cancel',
    response_id: 'late',
  });
  expect(f.agent.currentResponseId?.()).not.toBe('late');
  f.agent.dispose();
});
it('lets response controls cancel a lookup before redirecting', async () => {
  let requestSignal!: AbortSignal;
  const f = await setup((_args, context) => {
    requestSignal = context.signal;
    return new Promise(() => undefined);
  });
  f.completed();
  await settle();
  const control = f.agent.interruptResponse;
  if (!control) throw new Error('Missing response controls');
  expect(await control('parent', new AbortController().signal)).toBe(true);
  expect(requestSignal.aborted).toBe(true);
  expect(continuations(f)).toHaveLength(0);
  f.agent.dispose();
});
