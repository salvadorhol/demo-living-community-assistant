import { ConfigurationError } from './configuration-error.ts';
import { readOutputQueueMs } from './agent-config.ts';
export interface ServerConfig {
  firebaseProjectId: string;
  storageBucket?: string;
  maxCallMs?: number;
  voiceOutputQueueMs?: number;
  host: string;
  port: number;
  allowedOrigins: string[];
}

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig & {
  storageBucket: string;
  maxCallMs: number;
  voiceOutputQueueMs: number;
} {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ConfigurationError(
      'PORT must be an integer between 1 and 65535.',
    );
  }
  const host = env.HOST?.trim() ?? '127.0.0.1';
  if (!host) throw new ConfigurationError('HOST must not be empty.');
  const allowedOrigins = (
    env.CORS_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowedOrigins.length)
    throw new ConfigurationError(
      'CORS_ORIGINS must contain at least one browser origin.',
    );
  for (const origin of allowedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new ConfigurationError(
        'CORS_ORIGINS must contain complete HTTP(S) origins.',
      );
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new ConfigurationError(
        'CORS_ORIGINS must contain complete HTTP(S) origins without paths or wildcards.',
      );
    }
  }
  const firebaseProjectId = env.FIREBASE_PROJECT_ID?.trim();
  if (!firebaseProjectId)
    throw new ConfigurationError('FIREBASE_PROJECT_ID is required.');
  const storageBucket =
    env.FIREBASE_STORAGE_BUCKET?.trim() ||
    `${firebaseProjectId}-call-recordings`;
  if (!/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/.test(storageBucket))
    throw new ConfigurationError('Invalid FIREBASE_STORAGE_BUCKET.');
  const maxCallMs = Number(env.MAX_CALL_MS ?? 3600000);
  if (
    !Number.isSafeInteger(maxCallMs) ||
    maxCallMs < 1000 ||
    maxCallMs > 3600000
  )
    throw new ConfigurationError(
      'MAX_CALL_MS must be between 1000 and 3600000.',
    );
  return {
    host,
    port,
    allowedOrigins,
    firebaseProjectId,
    storageBucket,
    maxCallMs,
    voiceOutputQueueMs: readOutputQueueMs(env.VOICE_OUTPUT_QUEUE_MS),
  };
}
