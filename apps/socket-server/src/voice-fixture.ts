import { seedSophiePrompt } from './ai/seed-prompt.ts';
import { firebasePromptLoader } from './ai/prompt-store.ts';
import { createSophieTools, createContactLoader } from './ai/tools/sophie.ts';
import { createFirebaseInvoker } from './ai/tools/firebase-invoker.ts';
import { readFirebaseToolConfig } from './ai/tools/firebase-invoker.ts';
/** Playwright-only entrypoint. Exercises the real adapter against a local fake OpenAI WebSocket. */
import { createFakeOpenAI } from './testing/fake-openai.ts';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { firebaseCallStore } from './calls/firebase-call-store.ts';
import { createTranscriptionSession } from './ai/openai/transcription-session.ts';
import { createVoiceAgent } from './ai/create-agent.ts';
import { ASSISTANT_PROFILE } from './ai/assistant-profile.ts';
import { createRealtimeVoice } from './ai/openai/realtime-session.ts';
import { createSocketServer } from './server.ts';
import { createLogger } from './logger.ts';
import { readConfig } from './config.ts';

process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ??= '127.0.0.1:5001';
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
await seedSophiePrompt({ projectId: config.firebaseProjectId });
const upstream = await createFakeOpenAI({ toolCalls: true });
const connect = upstream.connect;
const toolConfig = readFirebaseToolConfig(config.firebaseProjectId);
const invoke = createFirebaseInvoker(toolConfig);
const loader = createContactLoader(invoke);
const provider = createVoiceAgent({
  voice: createRealtimeVoice('fixture-key', connect, {
    loadPrompt: firebasePromptLoader(firebase),
    tools: (uid) => createSophieTools(toolConfig, uid, { invoke, loader }),
    prefetch: (uid) => {
      void loader.load(uid);
    },
  }),
  transcription: (context) =>
    createTranscriptionSession(context, 'fixture-key', connect),
  metadata: { transcriptionModel: ASSISTANT_PROFILE.transcriptionModel },
});

const server = createSocketServer(
  config,
  (token) => getAuth(firebase).verifyIdToken(token),
  provider,
  firebaseCallStore(
    firebase,
    'demo-living-community-assistant.firebasestorage.app',
  ),
  undefined,
  createLogger({ LOG_LEVEL: 'warn', LOG_FORMAT: 'json' }),
);
server.httpServer.listen(config.port, config.host);
async function shutdown() {
  await server.close();
  await upstream.close();
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});
