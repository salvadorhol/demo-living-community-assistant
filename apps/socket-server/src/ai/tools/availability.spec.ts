import {createAvailabilityTools} from './availability.ts';
import {silentLogger} from '../../logger.ts';

const config = {
  projectId: 'demo-tools',
  region: 'us-central1',
  emulatorHost: '127.0.0.1:5001',
};
const call = {
  call_id: 'sales-one',
  name: 'check_sales_director_availability',
  arguments: '{}',
};
const context = () => ({
  uid: 'owner',
  logger: silentLogger,
  signal: new AbortController().signal,
});

it('registers a no-argument sales lookup and invokes its trusted function', async () => {
  const invoke = vi.fn(async () => ({mock: true, available: false}));
  const registry = createAvailabilityTools(config, invoke);
  expect(
    registry.definitions.find(tool => tool.name === call.name)
  ).toMatchObject({
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  });
  expect(
    registry.definitions.find(tool => tool.name === call.name)
  ).not.toHaveProperty('timeoutMs');
  expect(await registry.execute(call, context())).toEqual({
    ok: true,
    result: {mock: true, available: false},
  });
  expect(invoke).toHaveBeenCalledWith(
    'checkSalesDirectorAvailability',
    {},
    expect.any(AbortSignal)
  );
});

it.each(['{"uid":"other"}', '{"url":"https://untrusted"}', '[]', 'null'])(
  'rejects sales lookup arguments %s',
  async args => {
    const invoke = vi.fn();
    expect(
      await createAvailabilityTools(config, invoke).execute(
        {...call, arguments: args},
        context()
      )
    ).toMatchObject({ok: false, error: {code: 'INVALID_ARGUMENT'}});
    expect(invoke).not.toHaveBeenCalled();
  }
);

it.each([
  null,
  {},
  {mock: false, available: false},
  {mock: true, available: 'false'},
])('rejects malformed sales results %j', async value => {
  expect(
    await createAvailabilityTools(config, async () => value).execute(
      call,
      context()
    )
  ).toMatchObject({ok: false, error: {code: 'INVALID_RESULT'}});
});

it('allows the delayed sales response past the default deadline, but stops at twenty seconds', async () => {
  vi.useFakeTimers();
  try {
    const result = createAvailabilityTools(
      config,
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve({mock: true, available: false}), 12_000)
        )
    ).execute(call, context());
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await result).toMatchObject({ok: true});
    const stalled = createAvailabilityTools(
      config,
      () => new Promise(() => undefined)
    ).execute(call, context());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await stalled).toMatchObject({
      ok: false,
      error: {code: 'TOOL_TIMEOUT'},
    });
  } finally {
    vi.useRealTimers();
  }
});

it('aborts an in-flight sales request without returning a late result', async () => {
  const owner = new AbortController();
  let invocationSignal: AbortSignal | undefined;
  let complete!: (value: unknown) => void;
  const pending = createAvailabilityTools(config, (_name, _args, signal) => {
    invocationSignal = signal;
    return new Promise(resolve => {
      complete = resolve;
    });
  }).execute(call, {...context(), signal: owner.signal});
  const rejected = expect(pending).rejects.toBeDefined();
  await Promise.resolve();
  owner.abort();
  await rejected;
  expect(invocationSignal?.aborted).toBe(true);
  complete({mock: true, available: false});
});
