import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nx = require.resolve('nx/bin/nx.js');
let stopping;
function start(name, args, env = process.env) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: 'inherit',
    detached: true,
  });
  console.log(
    JSON.stringify({
      service: 'dev-launcher',
      event: 'child.spawned',
      name,
      pid: child.pid,
      time: new Date().toISOString(),
    }),
  );
  child.on('error', (error) => {
    console.error(
      JSON.stringify({
        service: 'dev-launcher',
        event: 'child.error',
        name,
        code: error.code,
        message: 'Child process could not start',
      }),
    );
    process.exitCode = 1;
    void stop();
  });
  child.on('exit', (code, signal) => {
    console.log(
      JSON.stringify({
        service: 'dev-launcher',
        event: 'child.exited',
        name,
        pid: child.pid,
        code,
        signal,
        stopping: Boolean(stopping),
        time: new Date().toISOString(),
      }),
    );
    if (!stopping) process.exitCode = code || 1;
    if (!stopping) void stop();
  });
  return child;
}
function terminate(child, group = true) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', resolve);
    try {
      if (group) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      resolve();
    }
  });
}
const emulators = start('emulators', ['tools/start-emulators.mjs']);
const watcher = start('functions-watch', [
  nx,
  'watch',
  '--projects=functions',
  '--includeDependencies',
  '--',
  'npx',
  'nx',
  'build',
  'functions',
]);
const socket = start(
  'socket-watch-supervisor',
  [
    '--env-file-if-exists=apps/socket-server/.env',
    '--watch',
    '--watch-preserve-output',
    '--unhandled-rejections=strict',
    'apps/socket-server/src/main.ts',
  ],
  {
    ...process.env,
    FIREBASE_PROJECT_ID: 'demo-living-community-assistant',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
    FIREBASE_STORAGE_BUCKET:
      'demo-living-community-assistant.firebasestorage.app',
  },
);
const web = start('web', [
  resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
  '--config',
  'apps/living-community-assistant/vite.config.mts',
  '--mode',
  'local-emulator',
]);
function stop() {
  return (stopping ??= (async () => {
    await Promise.all([terminate(web), terminate(watcher)]);
    await terminate(socket);
    await terminate(emulators, false);
  })());
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
