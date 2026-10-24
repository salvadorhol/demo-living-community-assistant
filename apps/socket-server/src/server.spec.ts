import type { DecodedIdToken } from 'firebase-admin/auth';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  HealthResponse,
  VoiceRoomSession,
} from '@living-community-assistant/types';
import { createSocketServer } from './server.ts';

let server: ReturnType<typeof createSocketServer>;
let url: string;
let startedAt: number;
const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

beforeEach(async () => {
  startedAt = Date.now();
  server = createSocketServer(
    {
      firebaseProjectId: 'demo-living-community-assistant',
      host: '127.0.0.1',
      port: 3000,
      allowedOrigins: ['http://localhost:4200'],
    },
    async (token) => {
      if (!['valid-token', 'other-token'].includes(token))
        throw new Error('Invalid token');
      return {
        uid: token === 'other-token' ? 'other-user' : 'anonymous-user',
      } as DecodedIdToken;
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once('error', reject);
    server.httpServer.listen(0, '127.0.0.1', resolve);
  });
  url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server.close();
});

function client(transport: 'websocket' | 'polling', origin?: string) {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    transports: [transport],
    auth: { token: 'valid-token' },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    timeout: 2000,
    extraHeaders: origin ? { Origin: origin } : undefined,
  });
  clients.push(socket);
  return socket;
}

function connect(socket: Socket<ServerToClientEvents, ClientToServerEvents>) {
  return new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
}

function expectHealth(value: HealthResponse) {
  expect(value.status).toBe('ok');
  expect(value.time).toBeGreaterThanOrEqual(startedAt);
  expect(value.time).toBeLessThanOrEqual(Date.now());
}

it('serves HTTP health with CORS for the React origin', async () => {
  const response = await fetch(`${url}/health`, {
    headers: { Origin: 'http://localhost:4200' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe(
    'http://localhost:4200',
  );
  expectHealth((await response.json()) as HealthResponse);
});

it('omits HTTP CORS permission for an unlisted browser origin', async () => {
  const response = await fetch(`${url}/health`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
});

it.each(['websocket', 'polling'] as const)(
  'supports %s events and health acknowledgements',
  async (transport) => {
    const socket = client(transport, 'http://localhost:4200');
    const initialHealth = new Promise<HealthResponse>((resolve) =>
      socket.once('health:status', resolve),
    );
    await connect(socket);
    expectHealth(await initialHealth);
    const response = await socket.timeout(2000).emitWithAck('health:check');
    expectHealth(response);
  },
);

it('accepts a non-browser websocket client without an Origin header', async () => {
  await connect(client('websocket'));
  expect(server.io.sockets.sockets.size).toBe(1);
});

it.each(['websocket', 'polling'] as const)(
  'rejects disallowed origins over %s',
  async (transport) => {
    await expect(
      connect(client(transport, 'https://untrusted.example')),
    ).rejects.toBeInstanceOf(Error);
    expect(server.io.sockets.sockets.size).toBe(0);
  },
);

it('ignores a malformed health event and continues serving the socket', async () => {
  const socket = client('websocket');
  await connect(socket);
  // Exercise untyped input from a non-TypeScript client.
  socket.emit(
    'health:check',
    undefined as unknown as (value: HealthResponse) => void,
  );
  expectHealth(await socket.timeout(2000).emitWithAck('health:check'));
});

it('disconnects clients and permits repeated shutdown', async () => {
  const socket = client('websocket');
  await connect(socket);
  const disconnected = new Promise<void>((resolve) =>
    socket.once('disconnect', () => resolve()),
  );
  await server.close();
  await disconnected;
  expect(server.httpServer.listening).toBe(false);
  expect(server.io.sockets.sockets.size).toBe(0);
  await server.close();
});

it('upgrades a default polling connection to WebSocket', async () => {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(url, {
    auth: { token: 'valid-token' },
    autoConnect: false,
    forceNew: true,
    reconnection: false,
    extraHeaders: { Origin: 'http://localhost:4200' },
  });
  clients.push(socket);
  socket.connect();
  const upgraded = new Promise<void>((resolve, reject) => {
    socket.io.engine.once('upgrade', () => resolve());
    socket.once('connect_error', reject);
  });
  await upgraded;
  expect(socket.io.engine.transport.name).toBe('websocket');
  expectHealth(await socket.timeout(2000).emitWithAck('health:check'));
});

it.each([undefined, '', 123, 'expired-token', 'wrong-project-token'])(
  'rejects invalid authentication %j',
  async (token) => {
    const socket = client('websocket');
    socket.auth = { token };
    await expect(connect(socket)).rejects.toThrow(/Authentication/);
    expect(server.io.sockets.sockets.size).toBe(0);
    expect(server.io.sockets.adapter.rooms.size).toBe(0);
  },
);
it('stores the verified identity on the socket', async () => {
  await connect(client('websocket'));
  expect([...server.io.sockets.sockets.values()][0].data.uid).toBe(
    'anonymous-user',
  );
});

function onServerDisconnect(
  socket: Socket<ServerToClientEvents, ClientToServerEvents>,
) {
  const peer = socket.id && server.io.sockets.sockets.get(socket.id);
  if (!peer) throw new Error('Expected a connected server socket');
  return new Promise<void>((resolve) =>
    peer.once('disconnect', () => resolve()),
  );
}

async function joinVoiceRoom(
  socket: Socket<ServerToClientEvents, ClientToServerEvents>,
) {
  const ready = new Promise<VoiceRoomSession>((resolve) =>
    socket.once('voice:session:ready', resolve),
  );
  await connect(socket);
  return ready;
}

it('shares rooms only within a verified UID and keeps them through microphone cycles', async () => {
  const first = client('websocket');
  const second = client('polling');
  const other = client('websocket');
  other.auth = { token: 'other-token' };
  const room = await joinVoiceRoom(first);
  expect(room.roomId).toEqual(expect.any(String));
  expect(await joinVoiceRoom(second)).toEqual(room);
  expect(await joinVoiceRoom(other)).not.toEqual(room);
  expect(server.io.sockets.adapter.rooms.get(room.roomId)?.size).toBe(2);
  const format = {
    encoding: 'pcm16le',
    sampleRate: 24000,
    channels: 1,
  } as const;
  for (const cancel of [false, true]) {
    expect(
      await first.timeout(1000).emitWithAck('audio:input:start', {
        streamId: 'input',
        format,
      }),
    ).toEqual({ ok: true });
    expect(
      await first.timeout(1000).emitWithAck('audio:input:stop', {
        streamId: 'input',
        cancel,
      }),
    ).toEqual({ ok: true });
    expect(server.io.sockets.adapter.rooms.get(room.roomId)?.size).toBe(2);
  }
  const left = onServerDisconnect(first);
  first.disconnect();
  await left;
  const third = client('websocket');
  expect(await joinVoiceRoom(third)).toEqual(room);
  expect(server.io.sockets.adapter.rooms.get(room.roomId)?.size).toBe(2);
});

it('removes the last member and creates a fresh session on reconnect', async () => {
  const socket = client('websocket');
  const room = await joinVoiceRoom(socket);
  const left = onServerDisconnect(socket);
  socket.disconnect();
  await left;
  expect(server.io.sockets.adapter.rooms.has(room.roomId)).toBe(false);
  expect(await joinVoiceRoom(socket)).not.toEqual(room);
  await server.close();
  expect(server.io.sockets.adapter.rooms.size).toBe(0);
});
