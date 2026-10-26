import {
  createFirebaseInvoker,
  readFirebaseToolConfig,
} from './firebase-invoker.ts';
import { createAvailabilityTools } from './availability.ts';
import { silentLogger } from '../../logger.ts';
const production = { projectId: 'real-project', region: 'us-central1' };
const emulator = {
  projectId: 'demo-tools',
  region: 'us-central1',
  emulatorHost: '127.0.0.1:5001',
};
const signal = () => new AbortController().signal;
it('uses an audience-specific Google ID token for private production functions', async () => {
  const getHeaders = vi.fn(async () => ({
    Authorization: 'Bearer private-id-token',
  }));
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ available: true }),
  );
  await createFirebaseInvoker(production, { fetch: request, getHeaders })(
    'getAvailableAppointments',
    {},
    signal(),
  );
  const endpoint =
    'https://us-central1-real-project.cloudfunctions.net/getAvailableAppointments';
  expect(getHeaders).toHaveBeenCalledWith(endpoint);
  expect(request).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({ method: 'POST', body: '{}', redirect: 'error' }),
  );
  expect(
    new Headers(request.mock.calls[0][1]?.headers).get('authorization'),
  ).toBe('Bearer private-id-token');
});
it('calls the explicit local emulator without requesting Google credentials', async () => {
  const getHeaders = vi.fn();
  const request = vi.fn<typeof fetch>(async () =>
    Response.json({ available: true }),
  );
  await createFirebaseInvoker(emulator, { fetch: request, getHeaders })(
    'getAvailableFloorPlans',
    {},
    signal(),
  );
  expect(request.mock.calls[0][0]).toBe(
    'http://127.0.0.1:5001/demo-tools/us-central1/getAvailableFloorPlans',
  );
  expect(getHeaders).not.toHaveBeenCalled();
});
it.each([
  ['real-project', '127.0.0.1:5001'],
  ['demo-tools', 'example.com:5001'],
  ['demo-tools', 'localhost'],
  ['demo-tools', 'localhost:5001/path'],
  ['demo-tools', 'user:password@localhost:5001'],
])('rejects unsafe emulator configuration %s/%s', (projectId, emulatorHost) => {
  expect(() =>
    readFirebaseToolConfig(projectId, {
      FIREBASE_FUNCTIONS_EMULATOR_HOST: emulatorHost,
    }),
  ).toThrow();
});
it('returns bounded, safe errors for HTTP, authentication, and result failures', async () => {
  await expect(
    createFirebaseInvoker(production, {
      getHeaders: async () => {
        throw new Error('private credentials');
      },
    })('getAvailableFloorPlans', {}, signal()),
  ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  for (const [response, code] of [
    [new Response('private error page', { status: 403 }), 'UPSTREAM_ERROR'],
    [new Response('not JSON'), 'INVALID_RESULT'],
    [
      new Response('broken', {
        headers: { 'content-type': 'application/json' },
      }),
      'INVALID_RESULT',
    ],
    [Response.json('x'.repeat(65537)), 'RESULT_TOO_LARGE'],
  ] as const) {
    await expect(
      createFirebaseInvoker(emulator, { fetch: async () => response })(
        'getAvailableFloorPlans',
        {},
        signal(),
      ),
    ).rejects.toMatchObject({ code });
  }
});
it('does not send a request if cancelled while obtaining an ID token', async () => {
  let finish!: (headers: Record<string, string>) => void;
  const getHeaders = () =>
    new Promise<Record<string, string>>((resolve) => {
      finish = resolve;
    });
  const request = vi.fn();
  const owner = new AbortController();
  const result = createFirebaseInvoker(production, {
    getHeaders,
    fetch: request,
  })('getAvailableFloorPlans', {}, owner.signal);
  owner.abort();
  finish({ Authorization: 'Bearer token' });
  await expect(result).rejects.toBeDefined();
  expect(request).not.toHaveBeenCalled();
});
it('validates availability contracts before passing results to the model', async () => {
  const registry = createAvailabilityTools(emulator, async () => ({
    floorPlans: 'invalid',
  }));
  expect(
    await registry.execute(
      { call_id: 'one', name: 'get_available_floor_plans', arguments: '{}' },
      { uid: 'owner', logger: silentLogger, signal: signal() },
    ),
  ).toMatchObject({ ok: false, error: { code: 'INVALID_RESULT' } });
});
