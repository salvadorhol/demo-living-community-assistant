import { io, type Socket } from 'socket.io-client';
import type {
  AudioAck,
  CallStatus,
  AudioPlaybackProgress,
  AudioChunk,
  AudioStream,
  AudioOutputEvent,
  ClientToServerEvents,
  ServerToClientEvents,
  VoiceRoomSession,
  TranscriptUpdate,
} from '@living-community-assistant/types';
import environment from '#firebase-environment';
import { ensureAnonymousSession } from './session';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
export interface ConnectionStatus {
  state: ConnectionState;
  error?: string;
  session?: VoiceRoomSession;
}

export interface SocketConnection {
  (): void;
  startAudio(stream: AudioStream): Promise<void>;
  endCall(): Promise<void>;
  retrySave(): Promise<void>;
  sendAudio(chunk: AudioChunk): Promise<void>;
  stopAudio(streamId: string, cancel?: boolean): Promise<void>;
  reportPlayback(progress: AudioPlaybackProgress): void;
  onTranscript(listener: (update: TranscriptUpdate) => void): () => void;
  onAudio(listener: (event: AudioOutputEvent) => void): () => void;
}

export function startSocket(
  onStatus: (status: ConnectionStatus) => void,
  onCall: (status: CallStatus) => void = () => undefined,
): SocketConnection {
  const transcriptListeners = new Set<(update: TranscriptUpdate) => void>();
  const audioListeners = new Set<(event: AudioOutputEvent) => void>();
  const emitAudio = (event: AudioOutputEvent) =>
    audioListeners.forEach((listener) => listener(event));
  let disposed = false;
  let refreshed = false;
  let forceRefresh = false;
  let session: VoiceRoomSession | undefined;
  let callId: string | undefined;
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
  socket.on('call:status', (value) => {
    if (disposed || !socket.connected || !session) return;
    if (value.state === 'active' && callId !== value.callId)
      callId = value.callId;
    if (callId === value.callId) onCall(value);
  });
  socket.on('transcript:update', (update) => {
    if (disposed || !socket.connected || !session) return;
    if (update.callId && update.callId !== callId) return;
    transcriptListeners.forEach((listener) => listener(update));
  });
  socket.on('voice:session:error', (error) =>
    emitAudio({ type: 'error', error }),
  );
  socket.on('voice:session:warning', (warning) =>
    emitAudio({ type: 'warning', warning }),
  );
  socket.on('audio:output:start', (stream) =>
    emitAudio({ type: 'start', stream }),
  );
  socket.on('audio:output:chunk', (chunk) =>
    emitAudio({ type: 'chunk', chunk }),
  );
  socket.on('audio:output:end', ({ streamId }) =>
    emitAudio({ type: 'end', streamId }),
  );
  socket.on('audio:output:clear', ({ streamId }) =>
    emitAudio({ type: 'clear', streamId }),
  );
  socket.on('connect', () => {
    refreshed = false;
    session = undefined;
    onStatus({ state: 'connecting' });
  });
  socket.on('voice:session:ready', (value) => {
    if (disposed || !socket.connected) return;
    session = value;
    onStatus({ state: 'connected', session });
  });
  socket.on('disconnect', () => {
    session = undefined;
    callId = undefined;
    onStatus({ state: 'disconnected' });
  });
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
  const close = () => {
    disposed = true;
    session = undefined;
    audioListeners.clear();
    transcriptListeners.clear();
    socket.removeAllListeners();
    socket.io.removeAllListeners();
    socket.disconnect();
  };
  function connected() {
    if (disposed || !socket.connected || !session)
      throw new Error('Socket disconnected. Start again after reconnecting.');
  }
  function accepted(result: AudioAck) {
    if (!result?.ok)
      throw new Error(result?.message ?? 'Audio request failed.');
  }
  return Object.assign(close, {
    async endCall() {
      connected();
      if (!callId) throw new Error('No active call.');
      accepted(await socket.timeout(5000).emitWithAck('call:end', { callId }));
    },
    async retrySave() {
      connected();
      if (!callId) throw new Error('No failed call.');
      accepted(
        await socket.timeout(5000).emitWithAck('call:retry', { callId }),
      );
    },
    async startAudio(stream: AudioStream) {
      connected();
      accepted(
        await socket.timeout(12000).emitWithAck('audio:input:start', stream),
      );
    },
    async sendAudio(chunk: AudioChunk) {
      connected();
      accepted(
        await socket.timeout(2000).emitWithAck('audio:input:chunk', chunk),
      );
    },
    async stopAudio(streamId: string, cancel = false) {
      connected();
      accepted(
        await socket
          .timeout(2000)
          .emitWithAck('audio:input:stop', { streamId, cancel }),
      );
    },
    reportPlayback(progress: AudioPlaybackProgress) {
      if (!disposed && socket.connected && session)
        socket.emit('audio:playback:progress', progress);
    },
    onTranscript(listener: (update: TranscriptUpdate) => void) {
      if (!disposed) transcriptListeners.add(listener);
      return () => {
        transcriptListeners.delete(listener);
      };
    },
    onAudio(listener: (event: AudioOutputEvent) => void) {
      audioListeners.add(listener);
      return () => {
        audioListeners.delete(listener);
      };
    },
  });
}
