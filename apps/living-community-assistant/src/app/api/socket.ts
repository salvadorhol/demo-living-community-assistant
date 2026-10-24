import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@living-community-assistant/types';
import environment from '#firebase-environment';
import { ensureAnonymousSession } from './session';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export interface ConnectionStatus {
  state: ConnectionState;
  error?: string;
}

export function startSocket(
  onStatus: (status: ConnectionStatus) => void,
): () => void {
  let disposed = false;
  let refreshed = false;
  let forceRefresh = false;
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
    environment.socketUrl,
    {
      autoConnect: false,
      auth: async (callback) => {
        try {
          const user = await ensureAnonymousSession();
          const token = await user.getIdToken(forceRefresh);
          forceRefresh = false;
          if (!disposed) callback({ token });
        } catch {
          if (!disposed) {
            socket.disconnect();
            onStatus({
              state: 'disconnected',
              error: 'Sign-in failed. Please retry.',
            });
          }
        }
      },
    },
  );
  socket.on('connect', () => {
    refreshed = false;
    onStatus({ state: 'connected' });
  });
  socket.on('disconnect', () => onStatus({ state: 'disconnected' }));
  socket.io.on('reconnect_attempt', () => onStatus({ state: 'connecting' }));
  socket.on('connect_error', (error: Error & { data?: { code?: string } }) => {
    if (error.data?.code === 'UNAUTHENTICATED' && !refreshed) {
      refreshed = true;
      forceRefresh = true;
      onStatus({ state: 'connecting' });
      socket.connect();
      return;
    }
    onStatus({
      state: 'disconnected',
      error:
        error.data?.code === 'UNAUTHENTICATED'
          ? 'Socket authentication failed. Please retry.'
          : 'Socket unavailable. Reconnecting automatically.',
    });
  });
  onStatus({ state: 'connecting' });
  void ensureAnonymousSession().then(
    () => {
      if (!disposed) socket.connect();
    },
    () => {
      if (!disposed)
        onStatus({
          state: 'disconnected',
          error: 'Sign-in failed. Please retry.',
        });
    },
  );
  return () => {
    disposed = true;
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
  };
}
