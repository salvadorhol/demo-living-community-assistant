import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  prepareEmulatorSecrets,
  TEST_ACCESS_PASSWORD,
  TEST_ADMIN_PASSWORD,
} from './emulator-secrets.mjs';

function fixture(run) {
  const root = mkdtempSync(resolve(tmpdir(), 'access-secrets-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('local emulators require an explicitly configured secret', () =>
  fixture((root) => {
    assert.throws(
      () => prepareEmulatorSecrets({ root }),
      /Create functions\/\.secret.local/,
    );
  }));
test('local emulators copy the configured file to the Functions source', () =>
  fixture((root) => {
    mkdirSync(resolve(root, 'functions'));
    const content =
      'APP_ACCESS_PASSWORD=local-only\nADMIN_ACCESS_PASSWORD=local-admin-only\n';
    writeFileSync(resolve(root, 'functions/.secret.local'), content);
    prepareEmulatorSecrets({ root });
    assert.equal(
      readFileSync(resolve(root, 'dist/functions/.secret.local'), 'utf8'),
      content,
    );
  }));
test('test emulators use the fixture password without copying a local secret', () =>
  fixture((root) => {
    mkdirSync(resolve(root, 'functions'));
    writeFileSync(
      resolve(root, 'functions/.secret.local'),
      'APP_ACCESS_PASSWORD=local-only\n',
    );
    prepareEmulatorSecrets({ root, test: true });
    assert.equal(
      readFileSync(resolve(root, 'dist/functions/.secret.local'), 'utf8'),
      `APP_ACCESS_PASSWORD=${TEST_ACCESS_PASSWORD}\nADMIN_ACCESS_PASSWORD=${TEST_ADMIN_PASSWORD}\nOPENAI_API_KEY=fixture-not-a-real-key\n`,
    );
  }));

test('local emulators reject missing passwords', () =>
  fixture((root) => {
    mkdirSync(resolve(root, 'functions'));
    for (const content of [
      'APP_ACCESS_PASSWORD=local-only\n',
      'ADMIN_ACCESS_PASSWORD=local-admin-only\n',
    ]) {
      writeFileSync(resolve(root, 'functions/.secret.local'), content);
      assert.throws(
        () => prepareEmulatorSecrets({ root }),
        /Set APP_ACCESS_PASSWORD/,
      );
    }
  }));

test('local emulators allow matching app and admin passwords', () =>
  fixture((root) => {
    mkdirSync(resolve(root, 'functions'));
    const content = 'APP_ACCESS_PASSWORD=same\nADMIN_ACCESS_PASSWORD=same\n';
    writeFileSync(resolve(root, 'functions/.secret.local'), content);
    prepareEmulatorSecrets({ root });
    assert.equal(
      readFileSync(resolve(root, 'dist/functions/.secret.local'), 'utf8'),
      content,
    );
  }));
