import pino, { type Logger, type DestinationStream } from 'pino';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

export type AppLogger = Logger;
const sensitive =
  /^(authorization|cookie|token|apiKey|api_key|key|password|secret|private_key|access_token|refresh_token|headers|audio|data|transcript|text|payload|uid)$/i;
function cleanString(value: string): string {
  let result = value
    .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [Redacted]')
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[Redacted]')
    .replace(
      /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      '[Redacted]',
    );
  for (const name of [
    'OPENAI_API_KEY',
    'FIREBASE_TOKEN',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]) {
    const secret = process.env[name];
    if (secret) result = result.split(secret).join('[Redacted]');
  }
  return result;
}
export function safeError(error: unknown, depth = 0): Record<string, unknown> {
  if (depth > 4) return { message: 'Cause chain truncated' };
  if (!(error instanceof Error))
    return { type: 'NonError', message: 'Non-Error failure' };
  const code = (error as NodeJS.ErrnoException).code;
  // JSON.parse errors can quote raw provider payloads, including private captions.
  const message =
    error instanceof SyntaxError
      ? 'Invalid syntax (payload omitted)'
      : error.message;
  const stack = error.stack?.replace(error.message, message);
  return {
    type: cleanString(error.name),
    message: cleanString(message),
    stack: stack && cleanString(stack),
    ...(typeof code === 'string' ? { code: cleanString(code) } : {}),
    ...(error.cause === undefined
      ? {}
      : { cause: safeError(error.cause, depth + 1) }),
  };
}
function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return cleanString(value);
  if (value instanceof Error) return safeError(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitive.test(key) ? '[Redacted]' : sanitize(item, seen),
    ]),
  );
}
export function createLogger(
  env: NodeJS.ProcessEnv = process.env,
  destination?: DestinationStream,
): AppLogger {
  const format =
    env.LOG_FORMAT ??
    (env.NODE_ENV === 'production' || env.CI ? 'json' : 'pretty');
  if (!['pretty', 'json'].includes(format))
    throw new Error('LOG_FORMAT must be pretty or json.');
  const level = env.LOG_LEVEL ?? 'info';
  if (
    !['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(
      level,
    )
  )
    throw new Error('Invalid LOG_LEVEL.');
  if (!destination && format === 'pretty') {
    const pretty = createRequire(`${process.cwd()}/package.json`)(
      'pino-pretty',
    );
    destination = pretty({
      sync: true,
      colorize: Boolean(process.stdout.isTTY),
      translateTime: 'SYS:standard',
    });
  }
  return pino(
    {
      level,
      base: {
        service: 'socket-server',
        pid: process.pid,
        instanceId: randomUUID(),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        err: (err) => (err instanceof Error ? safeError(err) : err),
      },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((arg) => sanitize(arg)) as typeof args);
        },
      },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}
// Library callers and tests can opt into logging without opening output streams.
export const silentLogger = pino({ level: 'silent' });
