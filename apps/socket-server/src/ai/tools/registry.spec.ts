import { createToolRegistry, TOOL_LIMITS } from './registry.ts';
import { isEmptyArguments } from './contracts.ts';
import { silentLogger } from '../../logger.ts';
const context = () => ({
  uid: 'owner',
  signal: new AbortController().signal,
  logger: silentLogger,
});
const definition = (execute = vi.fn(async () => ({ available: true }))) => ({
  name: 'lookup',
  description: 'Read availability data',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  validateArguments: isEmptyArguments,
  execute,
});
const call = (name = 'lookup', args = '{}') => ({
  call_id: 'tool-one',
  name,
  arguments: args,
});
it('exposes only model metadata and executes validated bindings', async () => {
  const tool = definition();
  const registry = createToolRegistry([tool]);
  expect(registry.definitions[0]).not.toHaveProperty('execute');
  expect(await registry.execute(call(), context())).toEqual({
    ok: true,
    result: { available: true },
  });
  expect(tool.execute).toHaveBeenCalledOnce();
});
it.each([
  'null',
  '[]',
  '{"url":"https://untrusted"}',
  'broken',
  'x'.repeat(8193),
])('rejects malformed or unsupported arguments %s', async (args) => {
  const tool = definition();
  expect(
    await createToolRegistry([tool]).execute(call('lookup', args), context()),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(tool.execute).not.toHaveBeenCalled();
});
it('rejects unknown or duplicate tool names', async () => {
  expect(() => createToolRegistry([definition(), definition()])).toThrow(
    'unique',
  );
  expect(await createToolRegistry([]).execute(call(), context())).toMatchObject(
    { ok: false, error: { code: 'UNKNOWN_TOOL' } },
  );
});
it('bounds a stuck executor and keeps its late result from being returned', async () => {
  vi.useFakeTimers();
  try {
    const tool = {
      ...definition(),
      execute: vi.fn(() => new Promise(() => undefined)),
    };
    const result = createToolRegistry([tool]).execute(call(), context());
    await vi.advanceTimersByTimeAsync(TOOL_LIMITS.timeoutMs + 1);
    expect(await result).toMatchObject({
      ok: false,
      error: { code: 'TOOL_TIMEOUT' },
    });
  } finally {
    vi.useRealTimers();
  }
});
it('cancels before invoking a binding and rejects on owner cancellation', async () => {
  const tool = definition();
  const owner = new AbortController();
  owner.abort();
  await expect(
    createToolRegistry([tool]).execute(call(), {
      ...context(),
      signal: owner.signal,
    }),
  ).rejects.toBeDefined();
  expect(tool.execute).not.toHaveBeenCalled();
});
it('contains executor exceptions and rejects oversized results', async () => {
  const failure = {
    ...definition(),
    execute: async () => {
      throw new Error('private provider payload');
    },
  };
  const failed = await createToolRegistry([failure]).execute(call(), context());
  expect(failed).toMatchObject({ ok: false, error: { code: 'TOOL_FAILED' } });
  expect(JSON.stringify(failed)).not.toContain('private provider');
  const large = { ...definition(), execute: async () => 'x'.repeat(65537) };
  expect(
    await createToolRegistry([large]).execute(call(), context()),
  ).toMatchObject({ ok: false, error: { code: 'RESULT_TOO_LARGE' } });
});
