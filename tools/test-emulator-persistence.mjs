import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { run } from './process.mjs';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const directory = mkdtempSync(join(tmpdir(), 'community-emulator-restart-'));
const config = JSON.parse(readFileSync(resolve(root, 'firebase.json'), 'utf8'));
delete config.functions;
delete config.hosting;
config.firestore.rules = resolve(root, config.firestore.rules);
config.firestore.indexes = resolve(root, config.firestore.indexes);
config.storage.rules = resolve(root, config.storage.rules);
for (const [service, port] of Object.entries({
  auth: 9499,
  firestore: 8480,
  storage: 9498,
  hub: 4503,
  logging: 4603,
}))
  config.emulators[service] = { host: '127.0.0.1', port };
delete config.emulators.functions;
config.emulators.firestore.websocketPort = 9450;
config.emulators.ui.enabled = false;
const configPath = join(directory, 'firebase.json');
writeFileSync(configPath, JSON.stringify(config));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  for (const mode of ['seed', 'verify']) {
    const args = [
      require.resolve('firebase-tools/lib/bin/firebase.js'),
      'emulators:exec',
      '--project',
      'demo-living-community-assistant',
      '--only',
      'auth,firestore,storage',
      '--config',
      configPath,
    ];
    args.push(
      mode === 'seed'
        ? `--export-on-exit=${join(directory, 'export')}`
        : `--import=${join(directory, 'export')}`,
    );
    args.push(
      [
        process.execPath,
        resolve(root, 'tools/persistence-fixture.mjs'),
        mode,
        join(directory, 'marker.json'),
      ]
        .map(quote)
        .join(' '),
    );
    run(process.execPath, args, { cwd: root });
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
