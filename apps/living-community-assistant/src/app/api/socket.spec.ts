import { startSocket } from './socket';
const mocks = vi.hoisted(() => ({
  options: {} as {
    auth: (callback: (value: unknown) => void) => Promise<void>;
  },
  handlers: {} as Record<
    string,
    (error?: Error & { data?: { code?: string } }) => void
  >,
  manager: {} as Record<
    string,
    (error?: Error & { data?: { code?: string } }) => void
  >,
  token: vi.fn(),
  session: vi.fn(),
  socket: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    io: { on: vi.fn(), removeAllListeners: vi.fn() },
  },
}));
vi.mock('./session', () => ({ ensureAnonymousSession: mocks.session }));
vi.mock('socket.io-client', () => ({
  io: vi.fn((_url, options) => {
    mocks.options = options;
    mocks.socket.on.mockImplementation((event, handler) => {
      mocks.handlers[event] = handler;
    });
    mocks.socket.io.on.mockImplementation((event, handler) => {
      mocks.manager[event] = handler;
    });
    return mocks.socket;
  }),
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ getIdToken: mocks.token });
  mocks.token.mockResolvedValue('id-token');
});
it('supplies a token and reflects connection and reconnect events', async () => {
  const status = vi.fn();
  const stop = startSocket(status);
  const callback = vi.fn();
  await mocks.options.auth(callback);
  expect(callback).toHaveBeenCalledWith({ token: 'id-token' });
  mocks.handlers.connect();
  expect(status).toHaveBeenLastCalledWith({ state: 'connected' });
  mocks.handlers.disconnect();
  expect(status).toHaveBeenLastCalledWith({ state: 'disconnected' });
  mocks.manager.reconnect_attempt();
  expect(status).toHaveBeenLastCalledWith({ state: 'connecting' });
  stop();
  expect(mocks.socket.disconnect).toHaveBeenCalled();
  expect(mocks.socket.removeAllListeners).toHaveBeenCalled();
});
it('refreshes once after rejection, then reports an auth failure', async () => {
  const status = vi.fn();
  const stop = startSocket(status);
  const error = Object.assign(new Error('rejected'), {
    data: { code: 'UNAUTHENTICATED' },
  });
  mocks.handlers.connect_error(error);
  await mocks.options.auth(vi.fn());
  expect(mocks.token).toHaveBeenLastCalledWith(true);
  mocks.handlers.connect_error(error);
  expect(status).toHaveBeenLastCalledWith({
    state: 'disconnected',
    error: 'Socket authentication failed. Please retry.',
  });
  stop();
});
it('reports sign-in failure and prevents pending work from connecting after cleanup', async () => {
  mocks.session.mockRejectedValueOnce(new Error('offline'));
  const status = vi.fn();
  const stop = startSocket(status);
  const callback = vi.fn();
  await Promise.resolve();
  expect(status).toHaveBeenLastCalledWith({
    state: 'disconnected',
    error: 'Sign-in failed. Please retry.',
  });
  stop();
  await mocks.options.auth(callback);
  expect(callback).not.toHaveBeenCalled();
});
