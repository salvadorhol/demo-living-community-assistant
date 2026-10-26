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
      ? {profile: {firstName: 'James', phone: '7045550100'}}
      : {profile: {}}
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  // Realtime may capture tools before speech_stopped reaches this server.
  const responseTools = registry.definitions;
  const prepared = value(
    await registry.execute(
      call('prepare_contact_information', {
        profile: {firstName: 'James', phone: '7045550100'},
      }),
      context
    )
  );
  const request = call('prepare_follow_up_request', {
    kind: 'callback',
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

it.each([false, true])(
  'keeps callback collection available after empty appointments, including failed director attempt %s',
  async failed => {
    const invoke = vi.fn(async (name: string) => {
      if (name === 'checkSalesDirectorAvailability') {
        if (failed) throw new Error('offline');
        return {available: false};
      }
      if (name === 'getContactInformation') return {profile: {}};
      return {timeZone: 'America/New_York', appointments: []};
    });
    const registry = createSophieTools(config, 'owner', {invoke});
    expect(
      await registry.execute(call('get_available_appointments'), context)
    ).toMatchObject({ok: true, result: {appointments: []}});
    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'checkSalesDirectorAvailability',
      'getAvailableAppointments',
    ]);
    expect(
      await registry.execute(call('get_available_appointments'), context)
    ).toMatchObject({ok: true, result: {appointments: []}});
    expect(
      invoke.mock.calls.filter(
        ([name]) => name === 'checkSalesDirectorAvailability'
      )
    ).toHaveLength(1);
    expect(registry.toolChoice?.()).toBe('auto');
    expect(registry.terminalAction?.()).toBeUndefined();
    expect(registry.definitions.map(t => t.name)).toContain(
      'prepare_contact_information'
    );
    expect(registry.definitions.map(t => t.name)).not.toContain(
      'simulate_sales_handoff'
    );
    expect(
      await registry.execute(call('get_contact_information'), context)
    ).toMatchObject({ok: true});
    expect(
      await registry.execute(
        call('prepare_contact_information', {profile: {phone: '7045550100'}}),
        context
      )
    ).toMatchObject({ok: true});
  }
);
it('preserves failed availability as an error without a transfer or call ending', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async () => {
      throw new Error('offline');
    },
  });
  await registry.execute(call('check_sales_director_availability'), context);
  expect(
    await registry.execute(call('get_available_appointments'), context)
  ).toMatchObject({ok: false});
  expect(registry.toolChoice?.()).toBe('auto');
  expect(registry.terminalAction?.()).toBeUndefined();
});
it('allows immediate termination after an empty result', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async name =>
      name === 'checkSalesDirectorAvailability'
        ? {available: false}
        : {timeZone: 'America/New_York', appointments: []},
  });
  await registry.execute(call('check_sales_director_availability'), context);
  await registry.execute(call('get_available_appointments'), context);
  await registry.execute(
    call('end_call', {reason: 'visitor_requested', language: 'en'}),
    context
  );
  expect(registry.terminalAction?.()).toEqual({
    reason: 'visitor_requested',
    immediate: true,
  });
});
it('requires phone rather than email for callbacks and rejects callback scheduling arguments', async () => {
  const registry = createSophieTools(config, 'owner', {
    invoke: async () => ({profile: {email: 'person@example.com'}}),
  });
  await registry.bootstrap?.(context.signal);
  expect(
    await registry.execute(
      call('prepare_follow_up_request', {kind: 'callback'}),
      context
    )
  ).toMatchObject({
    ok: false,
    error: {
      code: 'CONTACT_REQUIRED',
      message: expect.stringContaining('phone number'),
    },
  });
  for (const args of [
    {kind: 'callback', preferredTime: 'Tomorrow'},
    {kind: 'callback', slotId: 'slot'},
  ]) {
    expect(
      await registry.execute(call('prepare_follow_up_request', args), context)
    ).toMatchObject({ok: false, error: {code: 'INVALID_ARGUMENT'}});
  }
  const definition = registry.definitions.find(
    t => t.name === 'prepare_follow_up_request'
  );
  expect(definition).toBeDefined();
  expect(JSON.stringify(definition?.parameters)).not.toContain('preferredTime');
});
it('prepares unscheduled callbacks and requires a new confirmation turn before saving', async () => {
  const invoke = vi.fn(async (name: string, args: Record<string, unknown>) =>
    name === 'getContactInformation'
      ? {profile: {phone: '7045550100'}}
      : {requestId: args.requestId, kind: 'callback', status: 'pending'}
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  await registry.bootstrap?.(context.signal);
  const staged = value(
    await registry.execute(
      call('prepare_follow_up_request', {kind: 'callback'}),
      context
    )
  );
  expect(staged.valuesToReadBack).toEqual({
    kind: 'callback',
    arrangement: expect.stringContaining('normal operating hours'),
  });
  const save = {confirmationToken: staged.confirmationToken, confirmed: true};
  expect(
    await registry.execute(call('create_follow_up_request', save), context)
  ).toMatchObject({ok: false, error: {code: 'CONFIRMATION_REQUIRED'}});
  registry.onUserTurn?.();
  expect(
    await registry.execute(call('create_follow_up_request', save), context)
  ).toMatchObject({
    ok: true,
    result: {
      nextStep: expect.stringContaining('as soon as one becomes available'),
    },
  });
  const saved = invoke.mock.calls.find(
    ([name]) => name === 'createFollowUpRequest'
  );
  expect(saved?.[1].request).toEqual({kind: 'callback'});
  expect(
    await registry.execute(call('create_follow_up_request', save), context)
  ).toMatchObject({ok: true});
  expect(
    invoke.mock.calls
      .filter(([name]) => name === 'createFollowUpRequest')
      .map(([, args]) => args)
  ).toEqual([saved?.[1], saved?.[1]]);
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

const communityResult = {
  category: 'amenities',
  facts: {amenities: ['Gym', 'Exercise pool']},
  notProvided: [],
};
it('exposes community tools from call start and automatically checks the director before the requested lookup', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'checkSalesDirectorAvailability'
      ? {available: false}
      : communityResult
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  expect(registry.definitions.map(tool => tool.name)).toEqual(
    expect.arrayContaining([
      'get_community_information',
      'get_available_floor_plans',
      'get_available_appointments',
    ])
  );
  const result = await registry.execute(
    call('get_community_information', {category: 'amenities'}),
    context
  );
  expect(result).toMatchObject({
    ok: true,
    result: {
      ...communityResult,
      salesDirectorAvailability: {status: 'unavailable', attempted: true},
    },
  });
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'checkSalesDirectorAvailability',
    'getCommunityInformation',
  ]);
  await registry.execute(
    call('get_community_information', {category: 'amenities'}),
    context
  );
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'checkSalesDirectorAvailability',
    'getCommunityInformation',
    'getCommunityInformation',
  ]);
});
it.each(['failure', 'invalid'] as const)(
  'continues community lookups after a %s director attempt without automatically repeating it',
  async failure => {
    const invoke = vi.fn(async (name: string) => {
      if (name === 'checkSalesDirectorAvailability') {
        if (failure === 'failure')
          throw new Error('Director service unavailable');
        return {available: 'unknown'};
      }
      return communityResult;
    });
    const registry = createSophieTools(config, 'owner', {invoke});
    for (let i = 0; i < 2; i++) {
      expect(
        await registry.execute(
          call('get_community_information', {category: 'amenities'}),
          context
        )
      ).toMatchObject({
        ok: true,
        result: {
          facts: communityResult.facts,
          salesDirectorAvailability: {status: 'unknown'},
        },
      });
    }
    expect(
      invoke.mock.calls.filter(
        ([name]) => name === 'checkSalesDirectorAvailability'
      )
    ).toHaveLength(1);
  }
);
it('shares the pending director attempt between concurrent community, layout, appointment and explicit director calls', async () => {
  let release!: (value: unknown) => void;
  const invoke = vi.fn(async (name: string) => {
    if (name === 'checkSalesDirectorAvailability')
      return await new Promise(resolve => {
        release = resolve;
      });
    if (name === 'getAvailableFloorPlans') return {floorPlans: [], unknown: []};
    if (name === 'getAvailableAppointments')
      return {timeZone: 'America/New_York', appointments: []};
    return communityResult;
  });
  const registry = createSophieTools(config, 'owner', {invoke});
  const pending = [
    registry.execute(
      call('get_community_information', {category: 'amenities'}),
      context
    ),
    registry.execute(call('get_available_floor_plans'), context),
    registry.execute(call('get_available_appointments'), context),
    registry.execute(call('check_sales_director_availability'), context),
  ];
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  expect(invoke.mock.calls[0][0]).toBe('checkSalesDirectorAvailability');
  release({available: true});
  const results = await Promise.all(pending);
  expect(results.every(result => result.ok)).toBe(true);
  expect(results[0]).toMatchObject({
    result: {salesDirectorAvailability: {status: 'available'}},
  });
  expect(
    invoke.mock.calls.filter(
      ([name]) => name === 'checkSalesDirectorAvailability'
    )
  ).toHaveLength(1);
});
it('allows an explicit director recheck after the automatic initial attempt', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'checkSalesDirectorAvailability'
      ? {available: false}
      : communityResult
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  await registry.execute(
    call('get_community_information', {category: 'amenities'}),
    context
  );
  expect(
    await registry.execute(call('check_sales_director_availability'), context)
  ).toMatchObject({ok: true, result: {available: false}});
  await registry.execute(
    call('get_community_information', {category: 'amenities'}),
    context
  );
  expect(
    invoke.mock.calls.filter(
      ([name]) => name === 'checkSalesDirectorAvailability'
    )
  ).toHaveLength(2);
});
it('keeps the one-time director state separate for each call registry', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'checkSalesDirectorAvailability'
      ? {available: false}
      : communityResult
  );
  for (let i = 0; i < 2; i++)
    await createSophieTools(config, 'owner', {invoke}).execute(
      call('get_community_information', {category: 'amenities'}),
      context
    );
  expect(
    invoke.mock.calls.filter(
      ([name]) => name === 'checkSalesDirectorAvailability'
    )
  ).toHaveLength(2);
});
it('does not issue a community lookup after cancellation during the director attempt', async () => {
  const owner = new AbortController();
  const invoke = vi.fn(async () => new Promise(() => undefined));
  const registry = createSophieTools(config, 'owner', {invoke});
  const pending = registry.execute(
    call('get_community_information', {category: 'amenities'}),
    {...context, signal: owner.signal}
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  owner.abort(new Error('Visitor interrupted'));
  await rejected;
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledOnce();
});
it.each(['delayed', 'timeout'] as const)(
  'budgets time for a %s director attempt and still retrieves community facts',
  async mode => {
    vi.useFakeTimers();
    try {
      const invoke = vi.fn(async (name: string) => {
        if (name === 'checkSalesDirectorAvailability') {
          if (mode === 'timeout') return await new Promise(() => undefined);
          return await new Promise(resolve =>
            setTimeout(() => resolve({available: false}), 12000)
          );
        }
        return communityResult;
      });
      const registry = createSophieTools(config, 'owner', {invoke});
      const pending = registry.execute(
        call('get_community_information', {category: 'amenities'}),
        context
      );
      await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 20000 : 12000);
      expect(await pending).toMatchObject({
        ok: true,
        result: {
          facts: communityResult.facts,
          salesDirectorAvailability: {
            status: mode === 'timeout' ? 'unknown' : 'unavailable',
          },
        },
      });
      expect(invoke.mock.calls.map(([name]) => name)).toEqual([
        'checkSalesDirectorAvailability',
        'getCommunityInformation',
      ]);
    } finally {
      vi.useRealTimers();
    }
  }
);
it('validates community arguments before attempting the director prerequisite', async () => {
  const invoke = vi.fn();
  const registry = createSophieTools(config, 'owner', {invoke});
  expect(
    await registry.execute(
      call('get_community_information', {category: 'invented'}),
      context
    )
  ).toMatchObject({ok: false, error: {code: 'INVALID_ARGUMENT'}});
  expect(invoke).not.toHaveBeenCalled();
});

it('does not repeat an explicit initial director check when retrieving community facts', async () => {
  const invoke = vi.fn(async (name: string) =>
    name === 'checkSalesDirectorAvailability'
      ? {available: false}
      : communityResult
  );
  const registry = createSophieTools(config, 'owner', {invoke});
  await registry.execute(call('check_sales_director_availability'), context);
  await registry.execute(
    call('get_community_information', {category: 'amenities'}),
    context
  );
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'checkSalesDirectorAvailability',
    'getCommunityInformation',
  ]);
});
it('retries a failed community lookup without repeating the initial director attempt', async () => {
  let attempt = 0;
  const invoke = vi.fn(async (name: string) => {
    if (name === 'checkSalesDirectorAvailability') return {available: false};
    if (++attempt === 1) throw new Error('Community service unavailable');
    return communityResult;
  });
  const registry = createSophieTools(config, 'owner', {invoke});
  expect(
    await registry.execute(
      call('get_community_information', {category: 'amenities'}),
      context
    )
  ).toMatchObject({ok: false});
  expect(
    await registry.execute(
      call('get_community_information', {category: 'amenities'}),
      context
    )
  ).toMatchObject({ok: true, result: {facts: communityResult.facts}});
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'checkSalesDirectorAvailability',
    'getCommunityInformation',
    'getCommunityInformation',
  ]);
});
