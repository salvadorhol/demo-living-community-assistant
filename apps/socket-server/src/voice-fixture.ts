/** Playwright-only entrypoint. Exercises the real adapter against a local fake OpenAI WebSocket. */
import { WebSocketServer, WebSocket } from 'ws';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { AddressInfo } from 'node:net';
import { firebaseCallStore } from './call-store.ts';
import { withTranscription } from './transcription.ts';
import { createOpenAIAudio } from './openai-audio.ts';
import { createSocketServer } from './server.ts';
import { readConfig } from './config.ts';

process.env.FIREBASE_AUTH_EMULATOR_HOST ??= '127.0.0.1:9099';
process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= '127.0.0.1:9199';
const config = readConfig({
  ...process.env,
  FIREBASE_PROJECT_ID: 'demo-living-community-assistant',
  PORT: '3001',
  CORS_ORIGINS: 'http://localhost:4201,http://127.0.0.1:4201',
});
const firebase = initializeApp({
  projectId: config.firebaseProjectId,
  storageBucket: 'demo-living-community-assistant.firebasestorage.app',
});
const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((resolve) => upstream.once('listening', resolve));
upstream.on('connection', (socket) => {
  let turn = 0;
  let transcription = false;
  let transcribing = false;
  let active = false;
  let responded = false;
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (
      event.type === 'session.update' &&
      event.session.type === 'transcription'
    ) {
      transcription = true;
      socket.send(JSON.stringify({ type: 'session.updated' }));
      return;
    }
    if (transcription) {
      if (event.type === 'input_audio_buffer.append' && !transcribing) {
        transcribing = true;
        turn++;
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: `user-${turn}`,
            content_index: 0,
            delta: 'Hello from the resident.',
          }),
        );
      }
      if (event.type === 'input_audio_buffer.commit' && transcribing) {
        socket.send(
          JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: `user-${turn}`,
            content_index: 0,
            transcript: 'Hello from the resident.',
          }),
        );
        transcribing = false;
      }
      return;
    }
    if (event.type === 'session.update') {
      active = Boolean(event.session.audio?.input?.turn_detection);
      if (active) responded = false;
      socket.send(JSON.stringify({ type: 'session.updated' }));
    }
    if (event.type === 'input_audio_buffer.append' && active && !responded) {
      responded = true;
      const id = `fixture-${++turn}`;
      socket.send(
        JSON.stringify({ type: 'response.created', response: { id } }),
      );
      for (const type of [
        'response.output_audio_transcript.delta',
        'response.output_audio_transcript.done',
      ])
        socket.send(
          JSON.stringify({
            type,
            response_id: id,
            item_id: id,
            content_index: 0,
            delta: 'Hello! How can I help?',
            transcript: 'Hello! How can I help?',
          }),
        );
      // A short audible tone tests real browser scheduling without cloud calls.
      const pcm = Buffer.alloc(19200);
      for (let i = 0; i < pcm.length / 2; i++)
        pcm.writeInt16LE(
          Math.round(Math.sin((i * 2 * Math.PI * 440) / 24000) * 2000),
          i * 2,
        );
      socket.send(
        JSON.stringify({
          type: 'response.output_audio.delta',
          response_id: id,
          item_id: id,
          content_index: 0,
          delta: pcm.toString('base64'),
        }),
      );
      socket.send(
        JSON.stringify({ type: 'response.output_audio.done', item_id: id }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.done',
          response: { id, status: 'completed' },
        }),
      );
    }
  });
});
const connect = () =>
  new WebSocket(`ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
const provider = withTranscription(
  createOpenAIAudio(
    'fixture-key',
    () =>
      new WebSocket(
        `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      ),
  ),
  'fixture-key',
  connect,
);
const server = createSocketServer(
  config,
  (token) => getAuth(firebase).verifyIdToken(token),
  provider,
  firebaseCallStore(
    firebase,
    'demo-living-community-assistant.firebasestorage.app',
  ),
);
server.httpServer.listen(config.port, config.host);
async function shutdown() {
  await server.close();
  upstream.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
