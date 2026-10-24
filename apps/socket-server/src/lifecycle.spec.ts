import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const loggerUrl = new URL('./logger.ts', import.meta.url).href;
const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
const prelude = `import { createLogger } from ${JSON.stringify(loggerUrl)};
import { installFatalLogging, installShutdown } from ${JSON.stringify(lifecycleUrl)};
const logger = createLogger({ LOG_FORMAT: 'json' }); installFatalLogging(logger);`;
function execute(script: string) {
  return spawnSync(
    process.execPath,
    [
      '--unhandled-rejections=strict',
      '--input-type=module',
      '-e',
      prelude + script,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
}
it.each([
  [
    'exception',
    `setImmediate(() => { throw new Error('fixture crash'); });`,
    'uncaughtException',
  ],
  [
    'rejection',
    `Promise.reject(new Error('fixture crash'));`,
    'unhandledRejection',
  ],
])('writes fatal diagnostics before exiting on %s', (_name, code, origin) => {
  const result = execute(code);
  expect(result.status).toBe(1);
  const fatal = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'process.fatal');
  expect(fatal).toMatchObject({
    event: 'process.fatal',
    origin,
    err: { message: 'fixture crash' },
  });
});
it('logs startup configuration errors', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./main.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        LOG_FORMAT: 'json',
        FIREBASE_PROJECT_ID: '',
        PORT: '3000',
      },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('process.configuration_failed');
  expect(result.stdout).toContain('FIREBASE_PROJECT_ID is required');
});
it.each(['json', 'pretty'])('writes %s logs directly to stdout', (format) => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createLogger } from ${JSON.stringify(loggerUrl)}; createLogger({ LOG_FORMAT: '${format}' }).info('visible startup');`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('visible startup');
  if (format === 'json') expect(JSON.parse(result.stdout).level).toBe(30);
  else expect(result.stdout).toContain('INFO');
});
it('finishes graceful shutdown and reports failures and deadline overruns', () => {
  for (const [close, event, status] of [
    ['async () => {}', 'process.stopped', 0],
    [
      "async () => { throw new Error('close failed'); }",
      'process.shutdown_failed',
      1,
    ],
    ['() => new Promise(() => {})', 'process.shutdown_timeout', 1],
  ] as const) {
    const result = execute(
      `installShutdown(logger, ${close}, 100); process.emit('SIGTERM', 'SIGTERM');`,
    );
    expect(result.status).toBe(status);
    expect(result.stdout).toContain(event);
  }
});
it('preserves earlier logs when Node watch mode restarts the application', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'socket-watch-'));
  const file = join(dir, 'fixture.mjs');
  writeFileSync(
    file,
    `console.log('first-start'); setInterval(() => {}, 1000);`,
  );
  const child = spawn(
    process.execPath,
    ['--watch', '--watch-preserve-output', file],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errorOutput += chunk;
  });
  try {
    await vi.waitFor(() => expect(output).toContain('first-start'), {
      timeout: 4000,
    });
    writeFileSync(
      file,
      `console.log('second-start'); setInterval(() => {}, 1000);`,
    );
    await vi.waitFor(() => expect(output).toContain('second-start'), {
      timeout: 4000,
    });
    expect(output).toContain('first-start');
    expect(output + errorOutput).not.toContain('\u001bc');
    expect(output + errorOutput).not.toContain('\u001b[2J');
  } finally {
    const exited = new Promise<void>((resolve) =>
      child.once('exit', () => resolve()),
    );
    child.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('does not terminate early when the watch supervisor forwards a second shutdown signal', () => {
  const result = execute(
    `installShutdown(logger, () => new Promise(resolve => setTimeout(resolve, 50)), 500); process.kill(process.pid, 'SIGTERM'); setTimeout(() => process.kill(process.pid, 'SIGTERM'), 15);`,
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('process.stopped');
  expect(result.stdout.match(/process.shutdown"/g)).toHaveLength(1);
});

it.each([
  ['LOG_FORMAT', 'broken', 'LOG_FORMAT'],
  ['LOG_LEVEL', 'broken', 'LOG_LEVEL'],
  ['VOICE_OUTPUT_QUEUE_MS', 'NaN', 'VOICE_OUTPUT_QUEUE_MS'],
])(
  'surfaces invalid %s configuration and exits unsuccessfully',
  (name, value, message) => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./main.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          LOG_FORMAT: 'json',
          FIREBASE_PROJECT_ID: 'demo-local',
          [name]: value,
        },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('process.configuration_failed');
    expect(result.stdout).toContain(message);
    expect(result.stdout).not.toContain('server.listening');
  },
);
