import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nx = require.resolve('nx/bin/nx.js');
let stopping;
function start(args, env = process.env) {
  const child = spawn(process.execPath, args, {
    env,
    stdio: 'inherit',
    detached: true,
  });
  child.on('exit', () => {
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
const emulators = start(['tools/start-emulators.mjs']);
const watcher = start([
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
  [
    '--env-file-if-exists=apps/socket-server/.env',
    '--watch',
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
const web = start([
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
