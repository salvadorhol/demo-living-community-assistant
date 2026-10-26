const mocks = vi.hoisted(() => ({
  get: vi.fn(async () => ({exists: true, get: () => [] as unknown})),
}));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [{}],
  initializeApp: vi.fn(),
}));
vi.mock('firebase-admin/firestore', () => ({
  getFirestore: () => ({doc: () => ({get: mocks.get})}),
}));
import {
  checkSalesDirectorAvailability,
  getAvailableAppointments,
} from './availability';

vi.mock('firebase-functions/v2/https', () => ({
  onRequest: (_options: unknown, handler: unknown) => handler,
}));
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}));

const request = (method = 'POST', body: unknown = {}, json = true) => ({
  method,
  body,
  is: () => json,
});
const response = () => {
  const res = {set: vi.fn(), status: vi.fn(), json: vi.fn()};
  res.set.mockReturnValue(res);
  res.status.mockReturnValue(res);
  return res;
};

it('keeps the sales delay but returns configured appointments without an artificial wait', async () => {
  vi.useFakeTimers();
  try {
    const sales = response();
    const appointments = response();
    const pending = checkSalesDirectorAvailability(
      request() as never,
      sales as never
    );
    const existing = getAvailableAppointments(
      request('POST', {}) as never,
      appointments as never
    );
    await vi.advanceTimersByTimeAsync(1500);
    await existing;
    expect(appointments.json).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6499);
    expect(sales.json).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(sales.status).toHaveBeenCalledWith(200);
    expect(sales.json).toHaveBeenCalledWith({available: false});
    expect(sales.set).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store'
    );
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  ['GET', {}, true, 405],
  ['POST', {uid: 'other'}, true, 400],
  ['POST', [], true, 400],
  ['POST', null, true, 400],
  ['POST', {}, false, 400],
])(
  'rejects invalid sales requests immediately: %s %j',
  async (method, body, json, status) => {
    const res = response();
    await checkSalesDirectorAvailability(
      request(method, body, json) as never,
      res as never
    );
    expect(res.status).toHaveBeenCalledWith(status);
  }
);

it('returns no slots for an explicitly empty schedule', async () => {
  const res = response();
  await getAvailableAppointments(request() as never, res as never);
  expect(res.json).toHaveBeenCalledWith({
    timeZone: 'America/New_York',
    appointments: [],
  });
});
it('does not turn a failed configuration read into empty availability', async () => {
  mocks.get.mockRejectedValueOnce(new Error('offline'));
  const res = response();
  await getAvailableAppointments(request() as never, res as never);
  expect(res.status).toHaveBeenCalledWith(503);
});
it('rejects the obsolete date parameter', async () => {
  const res = response();
  await getAvailableAppointments(
    request('POST', {date: 'tomorrow'}) as never,
    res as never
  );
  expect(res.status).toHaveBeenCalledWith(400);
});
