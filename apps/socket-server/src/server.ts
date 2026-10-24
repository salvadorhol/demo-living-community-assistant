import type { DecodedIdToken } from 'firebase-admin/auth';
import { createServer } from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  HealthResponse,
} from '@living-community-assistant/types';
import { attachAudio, echoAudio, type AudioSessionFactory } from './audio.ts';
import type { ServerConfig } from './config.ts';

function health(): HealthResponse {
  return { status: 'ok', time: Date.now() };
}

export function createSocketServer(
  config: ServerConfig,
  verifyToken: (token: string) => Promise<DecodedIdToken>,
  audioFactory: AudioSessionFactory = echoAudio,
) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.allowedOrigins }));
  app.get('/health', (_request, response) => response.json(health()));

  const httpServer = createServer(app);
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    { uid: string }
  >(httpServer, {
    cors: { origin: config.allowedOrigins },
    // CORS alone does not restrict WebSocket upgrades.
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(
        null,
        origin === undefined || config.allowedOrigins.includes(origin),
      );
    },
  });
  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth.token;
    if (typeof token !== 'string' || !token.trim()) {
      next(
        Object.assign(new Error('Authentication required.'), {
          data: { code: 'UNAUTHENTICATED' },
        }),
      );
      return;
    }
    try {
      const decoded = await verifyToken(token);
      socket.data.uid = decoded.uid;
      next();
    } catch {
      next(
        Object.assign(new Error('Authentication failed.'), {
          data: { code: 'UNAUTHENTICATED' },
        }),
      );
    }
  });
  io.on('connection', (socket) => {
    attachAudio(socket, audioFactory);
    socket.emit('health:status', health());
    socket.on('health:check', (acknowledge) => {
      if (typeof acknowledge === 'function') acknowledge(health());
    });
  });

  let closing: Promise<void> | undefined;
  return {
    app,
    io,
    httpServer,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        io.close((error) => {
          if (
            error &&
            (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
          )
            reject(error);
          else resolve();
        });
        // Bound shutdown even when an HTTP client keeps its connection alive.
        httpServer.closeAllConnections();
      })),
  };
}
