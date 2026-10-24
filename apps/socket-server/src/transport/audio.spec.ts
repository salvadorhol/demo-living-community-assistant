import type { AddressInfo } from 'node:net';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { io, type Socket } from 'socket.io-client';
import type {
  AudioOutputEvent,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@living-community-assistant/types';
import { createSocketServer } from '../server.ts';
import type { AudioSessionFactory } from './audio.ts';

let server: ReturnType<typeof createSocketServer>;
let url: string;
let output: (event: AudioOutputEvent) => void;
const sink = {
  start: vi.fn(),
  write: vi.fn(),
  stop: vi.fn(),
  dispose: vi.fn(),
};
const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
beforeEach(async () => {
  vi.resetAllMocks();
  const factory: AudioSessionFactory = (context) => {
    output = context.output;
    return sink;
  };
  server = createSocketServer(
    {
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: ['http://localhost:4200'],
      firebaseProjectId: 'demo-living-community-assistant',
    },
    async (token) => {
      if (token !== 'valid') throw new Error('unauthenticated');
      return { uid: 'user' } as DecodedIdToken;
    },
    factory,
  );
  await new Promise<void>((resolve) =>
    server.httpServer.listen(0, '127.0.0.1', resolve),
  );
  url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});
afterEach(async () => {
  clients.forEach((socket) => socket.disconnect());
  clients.length = 0;
  await server.close();
});
async function client(transport: 'websocket' | 'polling' = 'websocket') {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    auth: { token: 'valid' },
    transports: [transport],
    reconnection: false,
  });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
}
const AUDIO_FORMAT = {
  encoding: 'pcm16le',
  sampleRate: 24000,
  channels: 1,
} as const;
const stream = { streamId: 'input', format: AUDIO_FORMAT };
const chunk = { streamId: 'input', sequence: 0, data: new Uint8Array(1920) };
it.each(['websocket', 'polling'] as const)(
  'accepts ordered PCM on %s and keeps output isolated to its socket',
  async (transport) => {
    const socket = await client(transport);
    const other = await client();
    const leaked = vi.fn();
    other.on('audio:output:chunk', leaked);
    expect(
      await socket.timeout(1000).emitWithAck('audio:input:start', stream),
    ).toEqual({ ok: true });
    expect(
      await socket.timeout(1000).emitWithAck('audio:input:chunk', chunk),
    ).toEqual({ ok: true });
    expect(sink.write).toHaveBeenCalledWith(expect.any(Uint8Array));
    const returned = new Promise<unknown>((resolve) =>
      socket.once('audio:output:chunk', resolve),
    );
    output({
      type: 'start',
      stream: { streamId: 'output', format: AUDIO_FORMAT },
    });
    output({ type: 'chunk', chunk: { ...chunk, streamId: 'output' } });
    await returned;
    expect(
      await socket
        .timeout(1000)
        .emitWithAck('audio:input:stop', { streamId: 'input' }),
    ).toEqual({ ok: true });
    expect(sink.stop).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();
    expect(
      (
        await socket
          .timeout(1000)
          .emitWithAck('audio:input:chunk', { ...chunk, sequence: 1 })
      ).ok,
    ).toBe(false);
  },
);
it('rejects malformed formats, chunks, ownership, and sequence without retaining input', async () => {
  const socket = await client();
  expect(
    (
      await socket.timeout(1000).emitWithAck('audio:input:start', {
        ...stream,
        format: { ...AUDIO_FORMAT, sampleRate: 48000 },
      } as unknown as typeof stream)
    ).ok,
  ).toBe(false);
  expect(
    (await socket.timeout(1000).emitWithAck('audio:input:chunk', chunk)).ok,
  ).toBe(false);
  await socket.timeout(1000).emitWithAck('audio:input:start', stream);
  for (const invalid of [
    { ...chunk, sequence: 1 },
    { ...chunk, streamId: 'other' },
    { ...chunk, data: new Uint8Array(1) },
    { ...chunk, data: new Uint8Array(4802) },
    { ...chunk, data: new Uint8Array() },
  ]) {
    expect(
      (await socket.timeout(1000).emitWithAck('audio:input:chunk', invalid)).ok,
    ).toBe(false);
  }
  expect(sink.write).not.toHaveBeenCalled();
  expect(
    (await socket.timeout(1000).emitWithAck('audio:input:start', stream)).ok,
  ).toBe(false);
});
it('cancels a stalled provider and ignores stale output and late failures', async () => {
  const socket = await client();
  await socket.timeout(1000).emitWithAck('audio:input:start', stream);
  const oldOutput = output;
  let reject!: (error: Error) => void;
  sink.write.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, failure) => {
        reject = failure;
      }),
  );
  const pending = socket.timeout(1000).emitWithAck('audio:input:chunk', chunk);
  await vi.waitFor(() => expect(sink.write).toHaveBeenCalled());
  expect(
    (
      await socket
        .timeout(1000)
        .emitWithAck('audio:input:chunk', { ...chunk, sequence: 1 })
    ).ok,
  ).toBe(false);
  expect(
    await socket
      .timeout(1000)
      .emitWithAck('audio:input:stop', { streamId: 'input', cancel: true }),
  ).toEqual({ ok: true });
  expect(sink.dispose).toHaveBeenCalledTimes(1);
  await socket
    .timeout(1000)
    .emitWithAck('audio:input:start', { ...stream, streamId: 'new' });
  reject(new Error('old failure'));
  await pending;
  const received = vi.fn();
  socket.on('audio:output:start', received);
  oldOutput({ type: 'start', stream });
  await socket.timeout(1000).emitWithAck('health:check');
  expect(received).not.toHaveBeenCalled();
  expect(sink.dispose).toHaveBeenCalledTimes(1);
  expect(
    await socket
      .timeout(1000)
      .emitWithAck('audio:input:chunk', { ...chunk, streamId: 'new' }),
  ).toEqual({ ok: true });
});
it('disposes on disconnect and forwards completion and clear from a fixture provider', async () => {
  const socket = await client();
  await socket.timeout(1000).emitWithAck('audio:input:start', stream);
  const ended = new Promise<unknown>((resolve) =>
    socket.once('audio:output:end', resolve),
  );
  const cleared = new Promise<unknown>((resolve) =>
    socket.once('audio:output:clear', resolve),
  );
  output({ type: 'end', streamId: 'fixture' });
  output({ type: 'clear', streamId: 'fixture' });
  expect(await ended).toEqual({ streamId: 'fixture' });
  expect(await cleared).toEqual({ streamId: 'fixture' });
  socket.disconnect();
  await vi.waitFor(() => expect(sink.dispose).toHaveBeenCalledTimes(1));
});
