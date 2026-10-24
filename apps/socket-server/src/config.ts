export interface ServerConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawPort = env.PORT ?? '3000';
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }
  const host = env.HOST?.trim() ?? '127.0.0.1';
  if (!host) throw new Error('HOST must not be empty.');
  const allowedOrigins = (
    env.CORS_ORIGINS ?? 'http://localhost:4200,http://127.0.0.1:4200'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (!allowedOrigins.length)
    throw new Error('CORS_ORIGINS must contain at least one browser origin.');
  for (const origin of allowedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('CORS_ORIGINS must contain complete HTTP(S) origins.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(
        'CORS_ORIGINS must contain complete HTTP(S) origins without paths or wildcards.',
      );
    }
  }
  return { host, port, allowedOrigins };
}
