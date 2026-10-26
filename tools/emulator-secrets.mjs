import { parseEnv } from 'node:util';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

export const TEST_ACCESS_PASSWORD = 'fixture-access-password';
export const TEST_ADMIN_PASSWORD = 'fixture-admin-password';

// Firebase reads emulator secrets relative to its configured Functions source.
// Keep this out of packaging: local passwords must never enter cached artifacts.
export function prepareEmulatorSecrets({ root, test = false }) {
  const directory = resolve(root, 'dist/functions');
  mkdirSync(directory, { recursive: true });
  const destination = resolve(directory, '.secret.local');
  if (test) {
    writeFileSync(
      destination,
      `APP_ACCESS_PASSWORD=${TEST_ACCESS_PASSWORD}\nADMIN_ACCESS_PASSWORD=${TEST_ADMIN_PASSWORD}\n`,
      { mode: 0o600 },
    );
    chmodSync(destination, 0o600);
    return;
  }
  const source = resolve(root, 'functions/.secret.local');
  if (!existsSync(source)) {
    throw new Error(
      'Create functions/.secret.local with APP_ACCESS_PASSWORD before starting emulators.',
    );
  }
  const values = parseEnv(readFileSync(source, 'utf8'));
  if (!values.APP_ACCESS_PASSWORD || !values.ADMIN_ACCESS_PASSWORD) {
    throw new Error(
      'Set APP_ACCESS_PASSWORD and ADMIN_ACCESS_PASSWORD values in functions/.secret.local.',
    );
  }
  copyFileSync(source, destination);
  chmodSync(destination, 0o600);
}
