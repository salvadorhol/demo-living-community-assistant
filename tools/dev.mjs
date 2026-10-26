import { persistLocalAppointments } from './local-appointments.mjs';
import { seedSophiePrompt } from './seed-sophie-prompt.mjs';
import { waitForEmulators } from './emulator-readiness.mjs';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const nx = require.resolve('nx/bin/nx.js');
let stopping;
let emulators, watcher, socket, web;
let stopAppointments;
const readiness = new AbortController();
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
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
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
function stop() {
  return (stopping ??= (async () => {
    readiness.abort();
    await Promise.all([terminate(web), terminate(watcher)]);
    await terminate(socket);
    try {
      await stopAppointments?.();
    } finally {
      await terminate(emulators, false);
    }
  })());
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  emulators = start('emulators', ['tools/start-emulators.mjs']);
  watcher = start('functions-watch', [
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
  const firebaseConfig = JSON.parse(
    readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'),
  );
  console.log(
    JSON.stringify({
      service: 'dev-launcher',
      event: 'emulators.waiting',
      message:
        'Waiting for Auth, Firestore, Functions, and Storage before starting socket server and frontend',
    }),
  );
  await waitForEmulators({
    hubUrl: `http://${firebaseConfig.emulators.hub?.host ?? '127.0.0.1'}:${firebaseConfig.emulators.hub?.port ?? 4400}`,
    signal: readiness.signal,
  });
  readiness.signal.throwIfAborted();
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  stopAppointments = await persistLocalAppointments();
  if (readiness.signal.aborted) {
    await stopAppointments();
    throw readiness.signal.reason;
  }
  await seedSophiePrompt({ projectId: 'demo-living-community-assistant' });
  console.log(
    JSON.stringify({ service: 'dev-launcher', event: 'emulators.ready' }),
  );
  socket = start(
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
      FIREBASE_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5001',
      FIREBASE_FUNCTIONS_REGION: 'us-central1',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
      FIREBASE_STORAGE_BUCKET:
        'demo-living-community-assistant.firebasestorage.app',
    },
  );
  web = start('web', [
    resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
    '--config',
    'apps/living-community-assistant/vite.config.mts',
    '--mode',
    'local-emulator',
  ]);
} catch (error) {
  if (!stopping) {
    console.error(
      JSON.stringify({
        service: 'dev-launcher',
        event: 'startup.failed',
        message:
          error instanceof Error ? error.message : 'Local startup failed',
      }),
    );
    process.exitCode = 1;
  }
  await stop();
}
