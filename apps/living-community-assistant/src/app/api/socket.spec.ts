import type { VoiceRoomSession } from '@living-community-assistant/types';
import { startSocket } from './socket';
const mocks = vi.hoisted(() => ({
  options: {} as {
    auth: (callback: (value: unknown) => void) => Promise<void>;
  },
  handlers: {} as Record<string, (value?: unknown) => void>,
  manager: {} as Record<
    string,
    (error?: Error & { data?: { code?: string } }) => void
  >,
  token: vi.fn(),
  session: vi.fn(),
  socket: {
    connected: true,
    emit: vi.fn(),
    timeout: vi.fn(),
    emitWithAck: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    io: { on: vi.fn(), removeAllListeners: vi.fn() },
  },
}));
vi.mock('./session', () => ({
  ensureAuthorizedSession: mocks.session,
  lockApp: vi.fn(async () => undefined),
}));
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
  mocks.socket.connected = true;
  mocks.socket.timeout.mockReturnValue(mocks.socket);
  mocks.socket.emitWithAck.mockResolvedValue({ ok: true });
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
  expect(status).toHaveBeenLastCalledWith({ state: 'connecting' });
  const session: VoiceRoomSession = { roomId: 'room-one' };
  mocks.handlers['voice:session:ready'](session);
  expect(status).toHaveBeenLastCalledWith({ state: 'connected', session });
  mocks.handlers.disconnect();
  expect(status).toHaveBeenLastCalledWith({ state: 'disconnected' });
  mocks.handlers.connect();
  mocks.handlers['voice:session:ready']({ roomId: 'room-two' });
  expect(status).toHaveBeenLastCalledWith({
    state: 'connected',
    session: { roomId: 'room-two' },
  });
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

it('bounds audio acknowledgements and prevents offline buffering', async () => {
  const connection = startSocket(vi.fn());
  await expect(connection.stopAudio('s')).rejects.toThrow('disconnected');
  mocks.handlers['voice:session:ready']({ roomId: 'room' });
  await connection.startAudio({
    streamId: 's',
    format: { encoding: 'pcm16le', sampleRate: 24000, channels: 1 },
  });
  expect(mocks.socket.timeout).toHaveBeenCalledWith(12000);
  await connection.sendAudio({
    streamId: 's',
    sequence: 0,
    data: new Uint8Array(2),
  });
  mocks.socket.emitWithAck.mockRejectedValueOnce(new Error('timeout'));
  await expect(connection.stopAudio('s')).rejects.toThrow('timeout');
  mocks.socket.emitWithAck.mockResolvedValueOnce({
    ok: false,
    message: 'Invalid stream',
  });
  await expect(connection.stopAudio('s')).rejects.toThrow('Invalid stream');
  mocks.socket.connected = false;
  await expect(
    connection.sendAudio({
      streamId: 's',
      sequence: 1,
      data: new Uint8Array(2),
    }),
  ).rejects.toThrow('disconnected');
  connection();
});

it('ignores session readiness after disposal', () => {
  const status = vi.fn();
  const close = startSocket(status);
  close();
  status.mockClear();
  mocks.handlers['voice:session:ready']({ roomId: 'late' });
  expect(status).not.toHaveBeenCalled();
});

it('delivers transcripts only for a ready connection and removes subscriptions', () => {
  const connection = startSocket(vi.fn());
  const listener = vi.fn();
  const update = {
    id: 'utterance',
    role: 'user',
    text: 'Hello',
    isFinal: false,
  };
  const unsubscribe = connection.onTranscript(listener);
  mocks.handlers['transcript:update'](update);
  expect(listener).not.toHaveBeenCalled();
  mocks.handlers['voice:session:ready']({ roomId: 'room' });
  mocks.handlers['transcript:update'](update);
  expect(listener).toHaveBeenCalledWith(update);
  unsubscribe();
  mocks.handlers['transcript:update'](update);
  expect(listener).toHaveBeenCalledTimes(1);
  connection.onTranscript(listener);
  mocks.handlers.disconnect();
  mocks.handlers['transcript:update'](update);
  expect(listener).toHaveBeenCalledTimes(1);
  connection();
  mocks.handlers['transcript:update'](update);
  expect(listener).toHaveBeenCalledTimes(1);
});

it('does not retry forbidden connections and signs out to restore the password gate', async () => {
  const { lockApp } = await import('./session');
  const status = vi.fn();
  startSocket(status);
  await Promise.resolve();
  mocks.socket.connect.mockClear();
  mocks.handlers.connect_error(
    Object.assign(new Error('Password required'), {
      data: { code: 'FORBIDDEN' },
    }),
  );
  expect(mocks.socket.disconnect).toHaveBeenCalled();
  expect(mocks.socket.connect).not.toHaveBeenCalled();
  expect(lockApp).toHaveBeenCalledOnce();
});
