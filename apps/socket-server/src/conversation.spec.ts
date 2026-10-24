import type { AddressInfo } from 'node:net';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  AudioOutputEvent,
} from '@living-community-assistant/types';
import { createSocketServer } from './server.ts';
import type { VoiceAgentFactory } from './conversation.ts';

const format = { encoding: 'pcm16le', sampleRate: 24000, channels: 1 } as const;
function fixture() {
  const agent = {
    initialize: vi.fn<() => Promise<void>>(async () => undefined),
    beginInput: vi.fn(),
    write: vi.fn(),
    pause: vi.fn(),
    progress: vi.fn(),
    dispose: vi.fn(),
  };
  return agent;
}
let server: ReturnType<typeof createSocketServer>;
const sockets: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];
let create: ReturnType<typeof vi.fn<VoiceAgentFactory['create']>>;
let agents: ReturnType<typeof fixture>[];
let outputs: ((event: AudioOutputEvent) => void)[];
beforeEach(async () => {
  agents = [];
  outputs = [];
  create = vi.fn(({ output }) => {
    const agent = fixture();
    agents.push(agent);
    outputs.push(output);
    return agent;
  });
  server = createSocketServer(
    {
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: [],
      firebaseProjectId: 'demo',
    },
    async () => ({ uid: 'shared-uid' }) as DecodedIdToken,
    { kind: 'conversation', create },
  );
  await new Promise<void>((resolve) =>
    server.httpServer.listen(0, '127.0.0.1', resolve),
  );
});
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.disconnect());
  await server.close();
});
async function client() {
  const socket = io(
    `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`,
    { auth: { token: 'test' }, reconnection: false },
  );
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('voice:session:ready', () => resolve());
    socket.once('connect_error', reject);
  });
  return socket;
}
const stream = (id: string) => ({ streamId: id, format });

it('creates agents lazily, preserves them across pauses, and isolates clients with the same UID', async () => {
  const first = await client();
  const second = await client();
  expect(create).not.toHaveBeenCalled();
  await first.timeout(1000).emitWithAck('audio:input:start', stream('first'));
  await second.timeout(1000).emitWithAck('audio:input:start', stream('second'));
  expect(create).toHaveBeenCalledTimes(2);
  const leaked = vi.fn();
  second.on('audio:output:chunk', leaked);
  const received = new Promise<void>((resolve) =>
    first.once('audio:output:chunk', () => resolve()),
  );
  outputs[0]({
    type: 'chunk',
    chunk: { streamId: 'out', sequence: 0, data: new Uint8Array(2) },
  });
  await received;
  await second.timeout(1000).emitWithAck('health:check');
  expect(leaked).not.toHaveBeenCalled();
  first.emit('audio:playback:progress', { streamId: 'out', playedMs: 10 });
  await first.timeout(1000).emitWithAck('health:check');
  expect(agents[0].progress).toHaveBeenCalledWith({
    streamId: 'out',
    playedMs: 10,
  });
  expect(agents[1].progress).not.toHaveBeenCalled();
  await first
    .timeout(1000)
    .emitWithAck('audio:input:stop', { streamId: 'first', cancel: true });
  await first.timeout(1000).emitWithAck('audio:input:start', stream('again'));
  expect(create).toHaveBeenCalledTimes(2);
  expect(agents[0].pause).toHaveBeenCalledOnce();
  expect(agents[0].dispose).not.toHaveBeenCalled();
  await server.close();
  expect(agents.every((agent) => agent.dispose.mock.calls.length === 1)).toBe(
    true,
  );
});

it('validates PCM and resets a failed agent without forwarding stale output', async () => {
  const socket = await client();
  await socket.timeout(1000).emitWithAck('audio:input:start', stream('in'));
  for (const chunk of [
    { streamId: 'wrong', sequence: 0, data: new Uint8Array(2) },
    { streamId: 'in', sequence: 1, data: new Uint8Array(2) },
    { streamId: 'in', sequence: 0, data: new Uint8Array(3) },
  ])
    expect(
      (await socket.timeout(1000).emitWithAck('audio:input:chunk', chunk)).ok,
    ).toBe(false);
  expect(agents[0].write).not.toHaveBeenCalled();
  const failure = new Promise<void>((resolve) =>
    socket.once('voice:session:error', () => resolve()),
  );
  outputs[0]({
    type: 'error',
    error: { code: 'VOICE_UNAVAILABLE', message: 'Retry' },
  });
  await failure;
  expect(agents[0].dispose).toHaveBeenCalledOnce();
  await socket.timeout(1000).emitWithAck('audio:input:start', stream('retry'));
  const leaked = vi.fn();
  socket.on('audio:output:start', leaked);
  outputs[0]({ type: 'start', stream: stream('stale') });
  await socket.timeout(1000).emitWithAck('health:check');
  expect(leaked).not.toHaveBeenCalled();
});

it('cancels pending initialization and rejects its late acknowledgement', async () => {
  const socket = await client();
  let finish: () => void = () => undefined;
  create.mockImplementationOnce(({ output }) => {
    const agent = fixture();
    agents.push(agent);
    outputs.push(output);
    agent.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    return agent;
  });
  const pending = socket
    .timeout(1000)
    .emitWithAck('audio:input:start', stream('pending'));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(
    await socket
      .timeout(1000)
      .emitWithAck('audio:input:stop', { streamId: 'pending', cancel: true }),
  ).toEqual({ ok: true });
  expect(agents[0].dispose).toHaveBeenCalledOnce();
  finish();
  expect((await pending).ok).toBe(false);
  expect(agents[0].beginInput).not.toHaveBeenCalled();
});

it('rejects another socket call ID, preserves a paused call, and ends it exactly once', async () => {
  const first = await client();
  const second = await client();
  const statuses: { callId: string; state: string }[] = [];
  first.on('call:status', (value) => statuses.push(value));
  await first.timeout(1000).emitWithAck('audio:input:start', stream('call'));
  const callId = statuses[0].callId;
  expect(
    (await second.timeout(1000).emitWithAck('call:end', { callId })).ok,
  ).toBe(false);
  await first
    .timeout(1000)
    .emitWithAck('audio:input:stop', { streamId: 'call' });
  expect(statuses.at(-1)?.state).toBe('paused');
  await first.timeout(1000).emitWithAck('call:end', { callId });
  await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('saved'));
  expect(agents[0].dispose).toHaveBeenCalledOnce();
  expect(
    (await first.timeout(1000).emitWithAck('call:end', { callId })).ok,
  ).toBe(true);
  await first
    .timeout(1000)
    .emitWithAck('audio:input:start', stream('new-call'));
  expect(statuses.at(-1)?.callId).not.toBe(callId);
  await first.timeout(1000).emitWithAck('call:end', { callId });
  expect(agents[1].dispose).not.toHaveBeenCalled();
});
