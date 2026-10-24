import type { AddressInfo } from 'node:net';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { io, type Socket } from 'socket.io-client';
import type {
  AudioChunk,
  AudioStream,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@living-community-assistant/types';
import { createSocketServer } from '../server.ts';

it.each(['websocket', 'polling'] as const)(
  'echoes exact PCM over %s, completes on Stop, and clears on cancellation',
  async (transport) => {
    const server = createSocketServer(
      {
        host: '127.0.0.1',
        port: 3000,
        allowedOrigins: [],
        firebaseProjectId: 'demo-living-community-assistant',
      },
      async () => ({ uid: 'anonymous' }) as DecodedIdToken,
    );
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, '127.0.0.1', resolve),
    );
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`,
      { transports: [transport], auth: { token: 'test' }, reconnection: false },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const stream: AudioStream = {
        streamId: 'echo',
        format: { encoding: 'pcm16le', sampleRate: 24000, channels: 1 },
      };
      const started = new Promise<AudioStream>((resolve) =>
        socket.once('audio:output:start', resolve),
      );
      expect(
        await socket.timeout(1000).emitWithAck('audio:input:start', stream),
      ).toEqual({ ok: true });
      expect(await started).toEqual(stream);
      for (let sequence = 0; sequence < 2; sequence++) {
        const data = new Uint8Array([0, 128, 255, 127, sequence, 0]);
        const echoed = new Promise<AudioChunk>((resolve) =>
          socket.once('audio:output:chunk', resolve),
        );
        await socket.timeout(1000).emitWithAck('audio:input:chunk', {
          streamId: 'echo',
          sequence,
          data,
        });
        const result = await echoed;
        expect(result.streamId).toBe('echo');
        expect(result.sequence).toBe(sequence);
        expect([...result.data]).toEqual([...data]);
      }
      const ended = new Promise<unknown>((resolve) =>
        socket.once('audio:output:end', resolve),
      );
      await socket
        .timeout(1000)
        .emitWithAck('audio:input:stop', { streamId: 'echo' });
      expect(await ended).toEqual({ streamId: 'echo' });
      await socket
        .timeout(1000)
        .emitWithAck('audio:input:start', { ...stream, streamId: 'again' });
      const cleared = new Promise<unknown>((resolve) =>
        socket.once('audio:output:clear', resolve),
      );
      await socket
        .timeout(1000)
        .emitWithAck('audio:input:stop', { streamId: 'again', cancel: true });
      expect(await cleared).toEqual({ streamId: 'again' });
    } finally {
      socket.disconnect();
      await server.close();
    }
  },
);
