import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForEmulators } from './emulator-readiness.mjs';
const services = Object.fromEntries(
  ['auth', 'firestore', 'functions', 'storage'].map((name, index) => [
    name,
    { host: '127.0.0.1', port: 1000 + index },
  ]),
);
function response(status, body = {}) {
  return new Response(JSON.stringify(body), { status });
}
test('waits beyond hub registration until Auth and the health function serve requests', async () => {
  let healthProbes = 0;
  let hubProbes = 0;
  const paths = [];
  await waitForEmulators({
    pollMs: 1,
    fetchService: async (url) => {
      paths.push(url);
      if (url.endsWith('/emulators')) {
        hubProbes++;
        if (hubProbes === 1) throw new Error('hub not listening');
        return response(200, services);
      }
      if (url.endsWith('/health'))
        return response(++healthProbes === 1 ? 503 : 200);
      if (url.includes('/config')) return response(200);
      return response(404);
    },
  });
  assert.ok(
    paths.some((url) =>
      url.includes(
        '/v0/b/demo-living-community-assistant.firebasestorage.app/o?maxResults=1',
      ),
    ),
  );
  assert.equal(healthProbes, 2);
  assert.equal(hubProbes, 3);
  assert.ok(
    paths.some((url) =>
      url.includes(
        '/emulator/v1/projects/demo-living-community-assistant/config',
      ),
    ),
  );
});
test('reports which services failed readiness and bounds waiting', async () => {
  await assert.rejects(
    waitForEmulators({
      timeoutMs: 30,
      pollMs: 1,
      fetchService: async (url) =>
        url.endsWith('/emulators') ? response(200, services) : response(503),
    }),
    /waiting for: auth, firestore, functions, storage/,
  );
});
test('supports cancellation during startup without starting dependent services', async () => {
  const controller = new AbortController();
  const waiting = waitForEmulators({
    signal: controller.signal,
    fetchService: async () => {
      throw new Error('not ready');
    },
  });
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
test('does not accept a registered Auth emulator with a failing config endpoint', async () => {
  await assert.rejects(
    waitForEmulators({
      timeoutMs: 30,
      pollMs: 1,
      fetchService: async (url) => {
        if (url.endsWith('/emulators')) return response(200, services);
        if (url.includes('/config')) return response(500);
        return response(200);
      },
    }),
    /waiting for: auth/,
  );
});
