import { createLogger } from './logger.ts';

it('filters levels and serializes errors, causes, and correlation fields without secrets', () => {
  const lines: string[] = [];
  const logger = createLogger(
    { LOG_FORMAT: 'json', LOG_LEVEL: 'info' },
    { write: (line) => lines.push(String(line)) },
  );
  logger.debug('hidden');
  const child = logger.child({ callId: 'call-one', socketId: 'socket-one' });
  child.error(
    {
      err: new Error('Bearer private-token sk-private', {
        cause: new Error('underlying failure'),
      }),
      token: 'private-token',
      payload: { text: 'private conversation' },
      nested: { authorization: 'private-header' },
    },
    'Operation failed',
  );
  expect(lines).toHaveLength(1);
  const entry = JSON.parse(lines[0]);
  expect(entry).toMatchObject({
    level: 50,
    service: 'socket-server',
    callId: 'call-one',
    socketId: 'socket-one',
    err: { type: 'Error', cause: { message: 'underlying failure' } },
  });
  expect(entry.err.stack).toContain('logger.spec.ts');
  expect(entry.instanceId).toBeTruthy();
  for (const secret of [
    'private-token',
    'sk-private',
    'private conversation',
    'private-header',
  ])
    expect(lines[0]).not.toContain(secret);
});

it('redacts configured credentials inside messages and nested causes', () => {
  vi.stubEnv('OPENAI_API_KEY', 'unusual-secret-value');
  try {
    const lines: string[] = [];
    const logger = createLogger(
      { LOG_FORMAT: 'json' },
      { write: (line) => lines.push(String(line)) },
    );
    logger.error(
      {
        err: new Error('unusual-secret-value', {
          cause: new Error('Bearer another-secret'),
        }),
      },
      'unusual-secret-value',
    );
    expect(lines.join('')).not.toContain('unusual-secret-value');
    expect(lines.join('')).not.toContain('another-secret');
  } finally {
    vi.unstubAllEnvs();
  }
});

it('validates format and level and allows silent output', () => {
  expect(() => createLogger({ LOG_FORMAT: 'invalid' })).toThrow('LOG_FORMAT');
  expect(() => createLogger({ LOG_LEVEL: 'invalid' })).toThrow('LOG_LEVEL');
  const write = vi.fn();
  createLogger({ LOG_FORMAT: 'json', LOG_LEVEL: 'silent' }, { write }).error(
    'hidden',
  );
  expect(write).not.toHaveBeenCalled();
});

it('does not expose provider payload fragments from JSON parse errors', () => {
  const lines: string[] = [];
  const logger = createLogger(
    { LOG_FORMAT: 'json' },
    { write: (line) => lines.push(String(line)) },
  );
  try {
    JSON.parse('private caption fragment');
  } catch (err) {
    logger.error({ err }, 'Invalid provider message');
  }
  expect(lines[0]).not.toContain('private caption fragment');
  expect(JSON.parse(lines[0])).toMatchObject({
    err: { type: 'SyntaxError', message: 'Invalid syntax (payload omitted)' },
  });
});
