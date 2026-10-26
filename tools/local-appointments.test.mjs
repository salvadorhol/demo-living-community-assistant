import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Timestamp} from 'firebase-admin/firestore';
import {
  readAppointmentsBackup,
  writeAppointmentsBackup,
  newerAppointments,
  persistLocalAppointments,
} from './local-appointments.mjs';
const projectId = 'demo-living-community-assistant';
const config = {
  slots: [{date: '2099-11-02', time: '10:00'}],
  revision: 2,
  updatedBy: 'local-admin',
  updatedAt: new Timestamp(1793020000, 123456789),
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'appointments-backup-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return join(directory, 'appointments.json');
}
test('round trips slots, revision, editor and exact timestamp through a local backup', t => {
  const path = fixture(t);
  assert.equal(readAppointmentsBackup(path, projectId), undefined);
  writeAppointmentsBackup(path, projectId, config);
  assert.deepEqual(readAppointmentsBackup(path, projectId), config);
});
test('persists an explicitly empty schedule', t => {
  const path = fixture(t);
  writeAppointmentsBackup(path, projectId, {...config, slots: []});
  assert.deepEqual(readAppointmentsBackup(path, projectId)?.slots, []);
});
test('rejects invalid settings without replacing the last valid backup', t => {
  const path = fixture(t);
  writeAppointmentsBackup(path, projectId, config);
  const before = readFileSync(path, 'utf8');
  assert.throws(() =>
    writeAppointmentsBackup(path, projectId, {
      ...config,
      slots: [{date: 'bad', time: 'bad'}],
    })
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});
test('refuses corrupt and foreign-project backups instead of silently resetting settings', t => {
  const path = fixture(t);
  writeAppointmentsBackup(path, projectId, config);
  assert.throws(
    () => readAppointmentsBackup(path, 'demo-other'),
    /different project/
  );
  writeFileSync(path, '{broken');
  assert.throws(() => readAppointmentsBackup(path, projectId));
});
test('restores missing or older settings but preserves newer Firestore settings', () => {
  assert.equal(newerAppointments(config, undefined), true);
  assert.equal(
    newerAppointments(config, {
      ...config,
      updatedAt: new Timestamp(config.updatedAt.seconds - 1, 0),
    }),
    true
  );
  assert.equal(
    newerAppointments(config, {
      ...config,
      updatedAt: new Timestamp(
        config.updatedAt.seconds,
        config.updatedAt.nanoseconds - 1
      ),
    }),
    true
  );
  assert.equal(newerAppointments(config, {...config, revision: 1}), true);
  assert.equal(newerAppointments(config, config), false);
  assert.equal(
    newerAppointments(config, {
      ...config,
      updatedAt: new Timestamp(config.updatedAt.seconds + 1, 0),
    }),
    false
  );
});
test('refuses production projects even with an emulator host configured', async () => {
  await assert.rejects(
    persistLocalAppointments({projectId: 'production-project'}),
    /demo project/
  );
});

test('fails promptly when the emulator is offline instead of leaving a background SDK retry loop', async t => {
  const oldHost = process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
  t.after(() => {
    if (oldHost === undefined) delete process.env.FIRESTORE_EMULATOR_HOST;
    else process.env.FIRESTORE_EMULATOR_HOST = oldHost;
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    persistLocalAppointments({path: fixture(t)}),
    /emulator is not running/
  );
});
