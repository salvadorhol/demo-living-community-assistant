import { setTimeout as delay } from 'node:timers/promises';

/** The hub registers services before Functions has loaded; verify HTTP readiness too. */
export async function waitForEmulators({
  hubUrl = 'http://127.0.0.1:4400',
  projectId = 'demo-living-community-assistant',
  timeoutMs = 90_000,
  pollMs = 250,
  signal,
  fetchService = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let pending = ['auth', 'firestore', 'functions', 'storage'];
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const probeSignal = AbortSignal.any([
      AbortSignal.timeout(Math.max(1, Math.min(1500, deadline - Date.now()))),
      ...(signal ? [signal] : []),
    ]);
    try {
      const hub = await fetchService(`${hubUrl}/emulators`, {
        signal: probeSignal,
      });
      if (!hub.ok) throw new Error('Emulator hub not ready');
      const services = await hub.json();
      const results = await Promise.all(
        ['auth', 'firestore', 'functions', 'storage'].map(async (name) => {
          const service = services[name];
          if (!service) return name;
          const host = service.host === '0.0.0.0' ? '127.0.0.1' : service.host;
          const path =
            name === 'auth'
              ? `/emulator/v1/projects/${projectId}/config`
              : name === 'functions'
                ? `/${projectId}/us-central1/health`
                : name === 'storage'
                  ? `/v0/b/${projectId}.firebasestorage.app/o?maxResults=1`
                  : '/';
          try {
            const response = await fetchService(
              `http://${host}:${service.port}${path}`,
              { signal: probeSignal },
            );
            // Firestore '/' may return 404; private Storage listing may return 401/403.
            const ready =
              name === 'auth' || name === 'functions'
                ? response.ok
                : response.status < 500;
            await response.body?.cancel();
            return ready ? undefined : name;
          } catch {
            return name;
          }
        }),
      );
      pending = results.filter(Boolean);
      if (!pending.length) return;
    } catch {
      // Expected while the emulator hub is still starting.
    }
    signal?.throwIfAborted();
    await delay(
      Math.min(pollMs, Math.max(1, deadline - Date.now())),
      undefined,
      { signal },
    );
  }
  throw new Error(
    `Emulators did not become ready within ${timeoutMs}ms (waiting for: ${pending.join(', ')}). Check emulator output above.`,
  );
}
