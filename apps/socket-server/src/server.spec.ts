import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  HealthResponse,
} from '@living-community-assistant/types';
import { createSocketServer } from './server.ts';

let server: ReturnType<typeof createSocketServer>;
let url: string;
let startedAt: number;
const clients: Socket<ServerToClientEvents, ClientToServerEvents>[] = [];

beforeEach(async () => {
  startedAt = Date.now();
  server = createSocketServer({
    host: '127.0.0.1',
    port: 3000,
    allowedOrigins: ['http://localhost:4200'],
  });
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
