import { createServer } from 'node:net';
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
const reserved = new Set();
async function availablePort() {
  for (;;) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    if (!reserved.has(port)) {
      reserved.add(port);
      return port;
    }
  }
}
for (const service of ['auth', 'firestore', 'storage', 'hub', 'logging'])
  config.emulators[service] = {
    host: '127.0.0.1',
    port: await availablePort(),
  };
delete config.emulators.functions;
config.emulators.firestore.websocketPort = await availablePort();
config.emulators.ui.enabled = false;
const configPath = join(directory, 'firebase.json');
writeFileSync(configPath, JSON.stringify(config));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
try {
  for (const mode of ['seed', 'update-config', 'verify']) {
    const args = [
      require.resolve('firebase-tools/lib/bin/firebase.js'),
      'emulators:exec',
      '--project',
      'demo-appointments-persistence',
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
