import { prepareEmulatorSecrets } from './emulator-secrets.mjs';
import { spawn } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, 'firebase-emulator-data');
prepareEmulatorSecrets({ root, test: process.argv.includes('--test') });
const args = [
  'emulators:start',
  '--project',
  'demo-living-community-assistant',
  '--only',
  'auth,firestore,functions,storage',
];
let configPath;
if (process.argv.includes('--test')) {
  configPath = resolve(root, `.firebase.smoke.${process.pid}.json`);
  const config = JSON.parse(
    readFileSync(resolve(root, 'firebase.json'), 'utf8'),
  );
  for (const [service, port] of Object.entries({
    auth: 9399,
    firestore: 8380,
    functions: 5301,
    storage: 9398,
    hub: 4502,
    logging: 4602,
  }))
    config.emulators[service] = { host: '127.0.0.1', port };
  config.emulators.firestore.websocketPort = 9350;
  config.emulators.ui.enabled = false;
  writeFileSync(configPath, JSON.stringify(config));
  args.push('--config', configPath);
}
if (!process.argv.includes('--ephemeral') && !process.argv.includes('--test')) {
  args.push(`--export-on-exit=${directory}`);
  if (existsSync(resolve(directory, 'firebase-export-metadata.json')))
    args.push(`--import=${directory}`);
  else if (existsSync(directory) && readdirSync(directory).length)
    throw new Error(
      'firebase-emulator-data is nonempty but has no export manifest. Move it aside or explicitly reset it before starting.',
    );
}
const child = spawn(
  process.execPath,
  [require.resolve('firebase-tools/lib/bin/firebase.js'), ...args],
  {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    // Use the CLI/SDK's file-based discovery instead of an extra temporary
    // HTTP server. The latter can time out before the emulator loads exports.
    env: { ...process.env, FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH: 'true' },
  },
);
let stopping = false;
function stop() {
  if (!stopping) {
    stopping = true;
    child.kill('SIGINT');
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  if (configPath) rmSync(configPath, { force: true });
  process.exitCode = stopping && code === 130 ? 0 : (code ?? 1);
});
