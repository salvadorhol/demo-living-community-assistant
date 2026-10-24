import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readConfig } from './config.ts';
import { createSocketServer } from './server.ts';
import { withTranscription } from './transcription.ts';
import { firebaseCallStore } from './call-store.ts';
import { createOpenAIAudio } from './openai-audio.ts';

const config = readConfig();
const firebase = initializeApp({
  projectId: config.firebaseProjectId,
  storageBucket: config.storageBucket,
});
const audioProvider = withTranscription(createOpenAIAudio());
const server = createSocketServer(
  config,
  (token) => getAuth(firebase).verifyIdToken(token),
  audioProvider,
  firebaseCallStore(firebase, config.storageBucket),
  config.maxCallMs,
);
server.httpServer.on('error', (error) => {
  console.error('Socket server failed:', error.message);
  process.exitCode = 1;
});
server.httpServer.listen(config.port, config.host, () => {
  console.log(
    `Socket server listening on http://${config.host}:${config.port}`,
  );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    await server.close();
  } catch (error) {
    console.error('Socket server shutdown failed:', error);
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
