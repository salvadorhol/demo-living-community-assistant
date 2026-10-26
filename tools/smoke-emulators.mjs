import { prepareEmulatorSecrets } from './emulator-secrets.mjs';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { workspaceRoot } from './config.mjs';
import { run } from './process.mjs';

const require = createRequire(import.meta.url);
const configPath = resolve(
  workspaceRoot,
  `.firebase.smoke.${process.pid}.json`,
);
const config = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'firebase.json'), 'utf8'),
);
for (const [service, port] of Object.entries({
  functions: 5101,
  firestore: 8180,
  auth: 9190,
  storage: 9298,
  hub: 4501,
  logging: 4601,
})) {
  config.emulators[service] = { host: '127.0.0.1', port };
}
config.emulators.firestore.websocketPort = 9250;
config.emulators.ui.enabled = false;
try {
  prepareEmulatorSecrets({ root: workspaceRoot, test: true });
  writeFileSync(configPath, JSON.stringify(config));
  run(
    process.execPath,
    [
      require.resolve('firebase-tools/lib/bin/firebase.js'),
      'emulators:exec',
      '--only',
      'auth,firestore,functions,storage',
      '--project',
      'demo-living-community-assistant',
      '--config',
      configPath,
      'node tools/seed-sophie-prompt.mjs --project demo-living-community-assistant && node tools/smoke-admin.mjs && node tools/smoke-health.mjs && node tools/smoke-access.mjs && node tools/smoke-tools.mjs && node tools/smoke-profile.mjs && node tools/test-call-security.mjs',
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, FIREBASE_FUNCTIONS_DISCOVERY_OUTPUT_PATH: 'true' },
    },
  );
} finally {
  rmSync(configPath, { force: true });
}
