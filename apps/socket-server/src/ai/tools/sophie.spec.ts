import {randomUUID} from 'node:crypto';
import {createContactLoader, createSophieTools} from './sophie.ts';
import {silentLogger} from '../../logger.ts';
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
  (result as {result: Record<string, unknown>}).result;

it.each([undefined, false, true])(
  'greets a returning visitor regardless of legacy consent %s',
  async legacyConsent => {
    const invoke = vi.fn(async () => ({
      profile: {firstName: 'James'},
      ...(legacyConsent === undefined ? {} : {consent: legacyConsent}),
    }));
    const registry = createSophieTools(config, 'owner', {invoke});
    await registry.bootstrap?.(context.signal);
    expect(registry.greeting?.()).toContain('Welcome back, James.');
    expect(invoke).toHaveBeenCalledWith(
      'getContactInformation',
      {uid: 'owner'},
      expect.any(AbortSignal)
    );
    expect(
      await registry.execute(
        call('get_contact_information', {uid: 'other'}),
        context
      )
    ).toMatchObject({ok: false, error: {code: 'INVALID_ARGUMENT'}});
  }
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
      signal: AbortSignal
    ) => Promise<unknown>
  >(async name =>
    name === 'saveContactInformation'
      ? {profile: {firstName: 'James'}}
      : {profile: {}}
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  expect(
    registry.definitions.some(t => t.name === 'save_contact_information')
  ).toBe(true);
  expect(
    await registry.execute(
      call('prepare_contact_information', {profile: {}}),
      context
    )
  ).toMatchObject({ok: false});
  const staged = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: {firstName: 'James'},
      }),
      context
    )
  );
  const save = call('save_contact_information', {
    confirmationToken: staged.confirmationToken,
    confirmed: true,
  });
  expect(await registry.execute(save, context)).toMatchObject({ok: false});
  registry.onUserTurn?.();
  expect(
    registry.definitions.some(t => t.name === 'save_contact_information')
  ).toBe(true);
  expect(
    await registry.execute(
      call('save_contact_information', {
        confirmationToken: 'invented',
        confirmed: true,
      }),
      context
    )
  ).toMatchObject({ok: false, error: {code: 'INVALID_ARGUMENT'}});
  expect(await registry.execute(save, context)).toMatchObject({ok: true});
  expect(invoke).toHaveBeenLastCalledWith(
    'saveContactInformation',
    expect.objectContaining({
      uid: 'owner',
      confirmed: true,
      profile: {firstName: 'James'},
      requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
    expect.any(AbortSignal)
  );
  const firstId = invoke.mock.calls.at(-1)?.[1];
  await registry.execute(save, context);
  expect(invoke.mock.calls.at(-1)?.[1]).toEqual(firstId);
});

it('replaces corrected drafts, expires confirmation, and never invokes after cancellation', async () => {
  vi.useFakeTimers();
  try {
    const invoke = vi.fn();
    const registry = createSophieTools(config, 'owner', {invoke});
    const old = value(
      await registry.execute(
        call('prepare_contact_information', {
          profile: {email: 'old@example.com'},
        }),
        context
      )
    );
    await registry.execute(
      call('prepare_contact_information', {
        profile: {email: 'correct@example.com'},
      }),
      context
    );
    registry.onUserTurn?.();
    expect(
      await registry.execute(
        call('save_contact_information', {
          confirmationToken: old.confirmationToken,
          confirmed: true,
        }),
        context
      )
    ).toMatchObject({ok: false});
    await vi.advanceTimersByTimeAsync(300_001);
    expect(
      await registry.execute(
        call('save_contact_information', {
          confirmationToken: old.confirmationToken,
          confirmed: true,
        }),
        context
      )
    ).toMatchObject({ok: false});
    const abort = new AbortController();
    abort.abort();
    await expect(
      registry.execute(call('get_contact_information'), {
        ...context,
        signal: abort.signal,
      })
    ).rejects.toBeDefined();
    expect(invoke).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it.each([undefined, false, true])(
  'prepares offered tours with remembered contact regardless of legacy consent %s',
  async legacyConsent => {
    const invoke = vi.fn(
      async (name: string, args: Record<string, unknown>) => {
        if (name === 'getContactInformation')
          return {
            profile: {email: 'visitor@example.com'},
            ...(legacyConsent === undefined ? {} : {consent: legacyConsent}),
          };
        if (name === 'getAvailableAppointments')
          return {
            timeZone: 'America/New_York',

            appointments: [
              {
                id: 'offered',
                date: '2099-11-02',
                startsAt: '2099-11-02T14:00:00Z',
                durationMinutes: 30,
              },
            ],
          };
        return {requestId: args.requestId, kind: 'tour', status: 'pending'};
      }
    );
    const registry = createSophieTools(config, 'owner', {invoke});
    await registry.bootstrap?.(context.signal);
    await registry.execute(call('check_sales_director_availability'), context);
    await registry.execute(call('get_available_appointments', {}), context);
    expect(
      await registry.execute(
        call('prepare_follow_up_request', {kind: 'tour', slotId: 'invented'}),
        context
      )
    ).toMatchObject({ok: false});
    const staged = value(
      await registry.execute(
        call('prepare_follow_up_request', {kind: 'tour', slotId: 'offered'}),
        context
      )
    );
    registry.onUserTurn?.();
    expect(
      await registry.execute(
        call('create_follow_up_request', {
          confirmationToken: staged.confirmationToken,
          confirmed: true,
        }),
        context
      )
    ).toMatchObject({ok: true, result: {status: 'pending'}});
  }
);

it('separates per-conversation draft state and invalidates cached profiles after a save', async () => {
  const invoke = vi.fn(async () => ({profile: {}}));
  const loader = createContactLoader(invoke);
  await loader.load('owner');
  await loader.load('owner');
  expect(invoke).toHaveBeenCalledTimes(1);
  loader.invalidate('owner');
  await loader.load('owner');
  expect(invoke).toHaveBeenCalledTimes(2);
  const owner = createSophieTools(config, 'owner', {invoke, loader});
  const other = createSophieTools(config, 'other', {invoke, loader});
  const prepared = value(
    await owner.execute(
      call('prepare_contact_information', {
        profile: {firstName: 'James'},
      }),
      context
    )
  );
  owner.onUserTurn?.();
  other.onUserTurn?.();
  expect(
    await other.execute(
      call('save_contact_information', {
        confirmationToken: prepared.confirmationToken,
        confirmed: true,
      }),
      {...context, uid: 'other'}
    )
  ).toMatchObject({ok: false});
});

it('keeps save actions in the response tool snapshot and recovers an unsaved follow-up prerequisite', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'saveContactInformation'
      ? {profile: {firstName: 'James', email: 'james@example.com'}}
      : {profile: {}}
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  // Realtime may capture tools before speech_stopped reaches this server.
  const responseTools = registry.definitions;
  const prepared = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: {firstName: 'James', email: 'james@example.com'},
      }),
      context
    )
  );
  const request = call('prepare_follow_up_request', {
    kind: 'callback',
    preferredTime: 'Tomorrow afternoon',
  });
  const missing = await registry.execute(request, context);
  expect(missing).toMatchObject({
    ok: false,
    error: {code: 'CONTACT_REQUIRED'},
  });
  expect(JSON.stringify(missing)).toContain('save_contact_information');
  expect(invoke).not.toHaveBeenCalled();
  registry.onUserTurn?.();
  expect(
    responseTools.some(tool => tool.name === 'save_contact_information')
  ).toBe(true);
  expect(
    await registry.execute(
      call('save_contact_information', {
        confirmationToken: prepared.confirmationToken,
        confirmed: true,
      }),
      context
    )
  ).toMatchObject({ok: true});
  expect(await registry.execute(request, context)).toMatchObject({ok: true});
});

it('requires the director attempt before appointments and forces handoff after empty availability', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async () => ({timeZone: 'America/New_York', appointments: []}),
  });
  expect(registry.toolChoice?.()).toBe('auto');
  expect(
    await registry.execute(
      call('simulate_sales_handoff', {language: 'en'}),
      context
    )
  ).toMatchObject({ok: false});
  expect(
    await registry.execute(call('get_available_appointments'), context)
  ).toMatchObject({ok: false});
  await registry.execute(call('check_sales_director_availability'), context);
  expect(
    await registry.execute(call('get_available_appointments', {}), context)
  ).toMatchObject({ok: true});
  expect(registry.toolChoice?.()).toEqual({
    type: 'function',
    name: 'simulate_sales_handoff',
  });
  expect(
    await registry.execute(
      call('simulate_sales_handoff', {language: 'en'}),
      context
    )
  ).toMatchObject({ok: true, result: {simulated: true, endingCall: true}});
  expect(registry.terminalAction?.()?.message).toContain('For this demo');
  expect(registry.definitions).toEqual([]);
  expect(
    await registry.execute(call('get_contact_information', {}), context)
  ).toMatchObject({ok: false});
});
it('never offers simulated handoff after a failed availability lookup', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async () => {
      throw new Error('offline');
    },
  });
  await registry.execute(call('check_sales_director_availability'), context);
  await registry.execute(call('get_available_appointments', {}), context);
  expect(registry.definitions.map(t => t.name)).not.toContain(
    'simulate_sales_handoff'
  );
});

it.each([false, true])(
  'enforces director-first gating, including failed director lookup %s',
  async failed => {
    const invoke = vi.fn(async (name: string) => {
      if (name === 'checkSalesDirectorAvailability') {
        if (failed) throw new Error('offline');
        return {available: false};
      }
      return {timeZone: 'America/New_York', appointments: []};
    });
    const registry = createSophieTools(config, 'owner', {invoke});
    expect(registry.definitions.map(t => t.name)).toContain('end_call');
    expect(registry.definitions.map(t => t.name)).not.toContain(
      'get_available_appointments'
    );
    await registry.execute(call('get_available_appointments'), context);
    expect(invoke).not.toHaveBeenCalled();
    await registry.execute(call('check_sales_director_availability'), context);
    expect(registry.definitions.map(t => t.name)).toContain(
      'get_available_appointments'
    );
    await registry.execute(call('get_available_appointments'), context);
    expect(registry.definitions.map(t => t.name).sort()).toEqual([
      'end_call',
      'simulate_sales_handoff',
    ]);
    expect(
      await registry.execute(call('get_available_appointments'), context)
    ).toMatchObject({ok: false});
    expect(invoke).toHaveBeenCalledTimes(2);
  }
);
it('allows an interrupted empty-result turn to choose immediate termination', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async name =>
      name === 'checkSalesDirectorAvailability'
        ? {available: false}
        : {timeZone: 'America/New_York', appointments: []},
  });
  await registry.execute(call('check_sales_director_availability'), context);
  await registry.execute(call('get_available_appointments'), context);
  expect(registry.toolChoice?.()).toMatchObject({
    name: 'simulate_sales_handoff',
  });
  registry.onUserTurn?.();
  expect(registry.toolChoice?.()).toBe('auto');
  await registry.execute(
    call('end_call', {reason: 'visitor_requested', language: 'en'}),
    context
  );
  expect(registry.terminalAction?.()).toEqual({
    reason: 'visitor_requested',
    immediate: true,
  });
});
it('provides timezone-aware tour read-backs without adding fields to the stored request', async () => {
  const invoke = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'getContactInformation')
      return {profile: {email: 'person@example.com'}};
    if (name === 'checkSalesDirectorAvailability') return {available: false};
    if (name === 'getAvailableAppointments')
      return {
        timeZone: 'America/New_York',
        appointments: [
          {
            id: 'slot',
            date: '2099-11-01',
            startsAt: '2099-11-01T15:00:00Z',
            localTime: '2099-11-01 10:00 America/New_York',
            durationMinutes: 30,
          },
        ],
      };
    return {requestId: args.requestId, kind: 'tour', status: 'pending'};
  });
  const registry = createSophieTools(config, 'owner', {invoke});
  await registry.bootstrap?.(context.signal);
  await registry.execute(call('check_sales_director_availability'), context);
  await registry.execute(call('get_available_appointments'), context);
  const staged = value(
    await registry.execute(
      call('prepare_follow_up_request', {kind: 'tour', slotId: 'slot'}),
      context
    )
  );
  expect(staged.valuesToReadBack).toMatchObject({
    localTime: '2099-11-01 10:00 America/New_York',
    timeZone: 'America/New_York',
  });
  registry.onUserTurn?.();
  await registry.execute(
    call('create_follow_up_request', {
      confirmationToken: staged.confirmationToken,
      confirmed: true,
    }),
    context
  );
  expect(invoke.mock.calls.at(-1)?.[1].request).toEqual({
    kind: 'tour',
    slotId: 'slot',
    date: '2099-11-01',
  });
});
it('includes per-tool courtesy and explicit-stop exceptions in model descriptions', () => {
  const registry = createSophieTools(config, 'owner', {invoke: vi.fn()});
  for (const tool of registry.definitions) {
    expect(tool.description).toContain(
      tool.name === 'end_call' ? 'no courtesy notice' : 'please-wait notice'
    );
  }
  expect(registry.greeting?.()).toContain('virtual sales assistant');
});
it('reuses the existing confirmed-contact token after an uncertain write', async () => {
  let writes = 0;
  const invoke = vi.fn(async (name: string) => {
    if (name === 'saveContactInformation') {
      if (++writes === 1) throw new Error('Response lost');
      return {profile: {email: 'person@example.com'}};
    }
    return {profile: {}};
  });
  const registry = createSophieTools(config, 'owner', {invoke});
  const staged = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: {email: 'person@example.com'},
      }),
      context
    )
  );
  registry.onUserTurn?.();
  const save = {confirmationToken: staged.confirmationToken, confirmed: true};
  expect(
    await registry.execute(call('save_contact_information', save), context)
  ).toMatchObject({
    ok: false,
    error: {message: expect.stringContaining('same confirmation token')},
  });
  expect(
    await registry.execute(call('save_contact_information', save), context)
  ).toMatchObject({ok: true});
  expect(invoke.mock.calls[0].slice(0, 2)).toEqual(
    invoke.mock.calls[1].slice(0, 2)
  );
});
it('natural ending selects a server goodbye without claiming a transfer', async () => {
  const registry = createSophieTools(config, 'owner', {invoke: vi.fn()});
  await registry.execute(
    call('end_call', {reason: 'conversation_complete', language: 'es'}),
    context
  );
  expect(registry.terminalAction?.()).toMatchObject({
    reason: 'conversation_complete',
    immediate: false,
    message: expect.stringContaining('Gracias'),
  });
  expect(registry.definitions).toEqual([]);
});
