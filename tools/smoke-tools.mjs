import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
// Verify the deployed export metadata as well as the HTTP behavior. Emulator IAM is not enforced.
const functions = require(resolve('dist/functions/main.cjs'));
const base =
  'http://127.0.0.1:5101/demo-living-community-assistant/us-central1';
for (const name of [
  'getAvailableAppointments',
  'getAvailableFloorPlans',
  'checkSalesDirectorAvailability',
]) {
  assert.deepEqual(functions[name].__endpoint.httpsTrigger.invoker, [
    'private',
  ]);
  const call = async (body) =>
    fetch(`${base}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const started = performance.now();
  const first = await call({});
  assert.equal(first.status, 200);
  const value = await first.json();
  assert.equal(value.mock, true);
  if (name !== 'checkSalesDirectorAvailability')
    assert.deepEqual(await (await call({})).json(), value);
  if (name === 'getAvailableAppointments') {
    assert.equal(value.timeZone, 'America/Detroit');
    assert.equal(value.appointments.length, 2);
    assert.equal(value.appointments[0].startsAt, '2026-11-02T10:00:00-05:00');
  } else if (name === 'getAvailableFloorPlans') {
    assert.equal(value.currency, 'USD');
    assert.deepEqual(
      value.floorPlans.map((plan) => plan.name),
      ['Fire', 'Maple', 'Oak'],
    );
    assert.equal(value.floorPlans[0].monthlyRent, 2500);
  } else {
    assert.deepEqual(value, { mock: true, available: false });
    assert.ok(
      performance.now() - started >= 8_000,
      'Sales lookup must wait eight seconds',
    );
    assert.equal(functions[name].__endpoint.timeoutSeconds, 20);
  }
  for (const body of [{ uid: 'untrusted' }, [], null, 'not an object'])
    assert.equal((await call(body)).status, 400);
  assert.equal((await fetch(`${base}/${name}`)).status, 405);
}
console.log(
  'Tool smoke passed: private exports, mock availability, deterministic data, and input/method validation.',
);
