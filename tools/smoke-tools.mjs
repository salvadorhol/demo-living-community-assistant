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
  const args =
    name === 'getAvailableAppointments' ? { date: 'next Monday' } : {};
  const first = await call(args);
  assert.equal(first.status, 200);
  const value = await first.json();
  assert.equal(Object.hasOwn(value, 'mock'), false);
  if (name !== 'checkSalesDirectorAvailability') {
    const second = await (await call(args)).json();
    assert.deepEqual(
      second.appointments ?? second,
      value.appointments ?? value,
    );
  }
  if (name === 'getAvailableAppointments') {
    assert.equal(value.timeZone, 'America/New_York');
    assert.ok(value.appointments.length > 0);
    assert.ok(Date.parse(value.appointments[0].startsAt) > Date.now());
  } else if (name === 'getAvailableFloorPlans') {
    assert.ok(value.unknown.includes('Room-specific pricing'));
    assert.deepEqual(
      value.floorPlans.map((plan) => plan.name),
      ['Studio', '1 Bedroom / 1 Bath', '2 Bedroom / 1.5 Bath'],
    );
    assert.equal(value.floorPlans[0].bathrooms, null);
  } else {
    assert.deepEqual(value, { available: false });
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
  'Tool smoke passed: private exports, availability, deterministic data, and input/method validation.',
);
