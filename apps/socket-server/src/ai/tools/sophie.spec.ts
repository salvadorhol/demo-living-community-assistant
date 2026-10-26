import { randomUUID } from 'node:crypto';
import { createContactLoader, createSophieTools } from './sophie.ts';
import { silentLogger } from '../../logger.ts';
const config = {
  projectId: 'demo-tools',
  region: 'us-central1',
  emulatorHost: '127.0.0.1:5001',
};
const context = {
  uid: 'owner',
  logger: silentLogger,
  signal: new AbortController().signal,
};
const call = (name: string, args: object = {}) => ({
  call_id: randomUUID(),
  name,
  arguments: JSON.stringify(args),
});
const value = (result: unknown) =>
  (result as { result: Record<string, unknown> }).result;

it.each([undefined, false, true])(
  'greets a returning visitor regardless of legacy consent %s',
  async (legacyConsent) => {
    const invoke = vi.fn(async () => ({
      profile: { firstName: 'James' },
      ...(legacyConsent === undefined ? {} : { consent: legacyConsent }),
    }));
    const registry = createSophieTools(config, 'owner', { invoke });
    await registry.bootstrap?.(context.signal);
    expect(registry.greeting?.()).toContain('Welcome back, James.');
    expect(invoke).toHaveBeenCalledWith(
      'getContactInformation',
      { uid: 'owner' },
      expect.any(AbortSignal),
    );
    expect(
      await registry.execute(
        call('get_contact_information', { uid: 'other' }),
        context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  },
);

it('bounds profile prefetch failures and does not greet late or invent a name', async () => {
  vi.useFakeTimers();
  try {
    const registry = createSophieTools(config, 'owner', {
      invoke: () => new Promise(() => undefined),
    });
    const pending = registry.bootstrap?.(context.signal);
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(registry.greeting?.()).toContain('My name is Sophie');
    expect(registry.greeting?.()).not.toContain('Welcome back');
  } finally {
    vi.useRealTimers();
  }
});

it('requires an exact read-back token, and a later turn before saving; merges via trusted UID', async () => {
  const invoke = vi.fn<
    (
      name: string,
      args: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<unknown>
  >(async (name) =>
    name === 'saveContactInformation'
      ? { profile: { firstName: 'James' } }
      : { profile: {} },
  );
  const registry = createSophieTools(config, 'owner', { invoke });
  expect(
    registry.definitions.some((t) => t.name === 'save_contact_information'),
  ).toBe(true);
  expect(
    await registry.execute(
      call('prepare_contact_information', { profile: {} }),
      context,
    ),
  ).toMatchObject({ ok: false });
  const staged = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: { firstName: 'James' },
      }),
      context,
    ),
  );
  const save = call('save_contact_information', {
    confirmationToken: staged.confirmationToken,
    confirmed: true,
  });
  expect(await registry.execute(save, context)).toMatchObject({ ok: false });
  registry.onUserTurn?.();
  expect(
    registry.definitions.some((t) => t.name === 'save_contact_information'),
  ).toBe(true);
  expect(
    await registry.execute(
      call('save_contact_information', {
        confirmationToken: 'invented',
        confirmed: true,
      }),
      context,
    ),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(await registry.execute(save, context)).toMatchObject({ ok: true });
  expect(invoke).toHaveBeenLastCalledWith(
    'saveContactInformation',
    expect.objectContaining({
      uid: 'owner',
      confirmed: true,
      profile: { firstName: 'James' },
      requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    expect.any(AbortSignal),
  );
  const firstId = invoke.mock.calls.at(-1)?.[1];
  await registry.execute(save, context);
  expect(invoke.mock.calls.at(-1)?.[1]).toEqual(firstId);
});

it('replaces corrected drafts, expires confirmation, and never invokes after cancellation', async () => {
  vi.useFakeTimers();
  try {
    const invoke = vi.fn();
    const registry = createSophieTools(config, 'owner', { invoke });
    const old = value(
      await registry.execute(
        call('prepare_contact_information', {
          profile: { email: 'old@example.com' },
        }),
        context,
      ),
    );
    await registry.execute(
      call('prepare_contact_information', {
        profile: { email: 'correct@example.com' },
      }),
      context,
    );
    registry.onUserTurn?.();
    expect(
      await registry.execute(
        call('save_contact_information', {
          confirmationToken: old.confirmationToken,
          confirmed: true,
        }),
        context,
      ),
    ).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(300_001);
    expect(
      await registry.execute(
        call('save_contact_information', {
          confirmationToken: old.confirmationToken,
          confirmed: true,
        }),
        context,
      ),
    ).toMatchObject({ ok: false });
    const abort = new AbortController();
    abort.abort();
    await expect(
      registry.execute(call('get_contact_information'), {
        ...context,
        signal: abort.signal,
      }),
    ).rejects.toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([undefined, false, true])(
  'prepares offered tours with remembered contact regardless of legacy consent %s',
  async (legacyConsent) => {
    const invoke = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        if (name === 'getContactInformation')
          return {
            profile: { email: 'visitor@example.com' },
            ...(legacyConsent === undefined ? {} : { consent: legacyConsent }),
          };
        if (name === 'getAvailableAppointments')
          return {
            timeZone: 'America/New_York',
            requestedDate: '2099-11-02',
            appointments: [
              {
                id: 'offered',
                startsAt: '2099-11-02T14:00:00Z',
                durationMinutes: 30,
              },
            ],
          };
        return { requestId: args.requestId, kind: 'tour', status: 'pending' };
      },
    );
    const registry = createSophieTools(config, 'owner', { invoke });
    await registry.bootstrap?.(context.signal);
    await registry.execute(
      call('get_available_appointments', { date: '2099-11-02' }),
      context,
    );
    expect(
      await registry.execute(
        call('prepare_follow_up_request', { kind: 'tour', slotId: 'invented' }),
        context,
      ),
    ).toMatchObject({ ok: false });
    const staged = value(
      await registry.execute(
        call('prepare_follow_up_request', { kind: 'tour', slotId: 'offered' }),
        context,
      ),
    );
    registry.onUserTurn?.();
    expect(
      await registry.execute(
        call('create_follow_up_request', {
          confirmationToken: staged.confirmationToken,
          confirmed: true,
        }),
        context,
      ),
    ).toMatchObject({ ok: true, result: { status: 'pending' } });
  },
);

it('separates per-conversation draft state and invalidates cached profiles after a save', async () => {
  const invoke = vi.fn(async () => ({ profile: {} }));
  const loader = createContactLoader(invoke);
  await loader.load('owner');
  await loader.load('owner');
  expect(invoke).toHaveBeenCalledTimes(1);
  loader.invalidate('owner');
  await loader.load('owner');
  expect(invoke).toHaveBeenCalledTimes(2);
  const owner = createSophieTools(config, 'owner', { invoke, loader });
  const other = createSophieTools(config, 'other', { invoke, loader });
  const prepared = value(
    await owner.execute(
      call('prepare_contact_information', {
        profile: { firstName: 'James' },
      }),
      context,
    ),
  );
  owner.onUserTurn?.();
  other.onUserTurn?.();
  expect(
    await other.execute(
      call('save_contact_information', {
        confirmationToken: prepared.confirmationToken,
        confirmed: true,
      }),
      { ...context, uid: 'other' },
    ),
  ).toMatchObject({ ok: false });
});

it('keeps save actions in the response tool snapshot and recovers an unsaved follow-up prerequisite', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'saveContactInformation'
      ? { profile: { firstName: 'James', email: 'james@example.com' } }
      : { profile: {} },
  );
  const registry = createSophieTools(config, 'owner', { invoke });
  // Realtime may capture tools before speech_stopped reaches this server.
  const responseTools = registry.definitions;
  const prepared = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: { firstName: 'James', email: 'james@example.com' },
      }),
      context,
    ),
  );
  const request = call('prepare_follow_up_request', {
    kind: 'callback',
    preferredTime: 'Tomorrow afternoon',
  });
  const missing = await registry.execute(request, context);
  expect(missing).toMatchObject({
    ok: false,
    error: { code: 'CONTACT_REQUIRED' },
  });
  expect(JSON.stringify(missing)).toContain('save_contact_information');
  expect(invoke).not.toHaveBeenCalled();
  registry.onUserTurn?.();
  expect(
    responseTools.some((tool) => tool.name === 'save_contact_information'),
  ).toBe(true);
  expect(
    await registry.execute(
      call('save_contact_information', {
        confirmationToken: prepared.confirmationToken,
        confirmed: true,
      }),
      context,
    ),
  ).toMatchObject({ ok: true });
  expect(await registry.execute(request, context)).toMatchObject({ ok: true });
});
