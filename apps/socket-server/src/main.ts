import { createLogger } from './logger.ts';
import { installFatalLogging, installShutdown } from './lifecycle.ts';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readConfig } from './config.ts';
import { createSocketServer } from './server.ts';
import { withTranscription } from './transcription.ts';
import { firebaseCallStore } from './call-store.ts';
import { createOpenAIAudio } from './openai-audio.ts';

// A JSON fallback keeps invalid logging configuration visible.
let logger;
try {
  logger = createLogger();
} catch (err) {
  logger = createLogger({ LOG_FORMAT: 'json' });
  logger.fatal(
    { event: 'process.configuration_failed', err },
    'Invalid logging configuration',
  );
  process.exit(1);
}
installFatalLogging(logger);
logger.info(
  { event: 'process.starting', nodeVersion: process.version },
  'Socket server starting',
);
try {
  const config = readConfig();
  const firebase = initializeApp({
    projectId: config.firebaseProjectId,
    storageBucket: config.storageBucket,
  });
  const server = createSocketServer(
    config,
    (token) => getAuth(firebase).verifyIdToken(token),
    withTranscription(createOpenAIAudio()),
    firebaseCallStore(firebase, config.storageBucket),
    config.maxCallMs,
    logger,
  );
  installShutdown(logger, server.close);
  server.httpServer.on('error', (err) => {
    logger.fatal(
      { event: 'server.listen_failed', err },
      'Socket server failed',
    );
    logger.flush();
    process.exit(1);
  });
  server.httpServer.listen(config.port, config.host, () => {
    logger.info(
      {
        event: 'server.listening',
        host: config.host,
        port: config.port,
        voiceConfigured: Boolean(process.env.OPENAI_API_KEY),
        emulators: [
          'FIREBASE_AUTH_EMULATOR_HOST',
          'FIRESTORE_EMULATOR_HOST',
          'FIREBASE_STORAGE_EMULATOR_HOST',
        ].filter((name) => Boolean(process.env[name])),
      },
      'Socket server listening',
    );
  });
} catch (err) {
  logger.fatal(
    { event: 'process.start_failed', err },
    'Socket server startup failed',
  );
  logger.flush();
  process.exit(1);
}
