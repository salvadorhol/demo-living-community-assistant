import { test, expect, type Page } from '@playwright/test';

async function storedUser(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ uid: string; isAnonymous: boolean }>((resolve, reject) => {
        const request = indexedDB.open('firebaseLocalStorageDb');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('firebaseLocalStorage')
            .objectStore('firebaseLocalStorage')
            .getAll();
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
          read.onsuccess = () => {
            db.close();
            resolve(
              read.result.find((record) =>
                record.fbase_key.startsWith('firebase:authUser:'),
              )?.value,
            );
          };
        };
      }),
  );
}

test('shows the workspace and connects to the backend', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Living Community Assistant',
  );
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket connected', { timeout: 60_000 });
  const user = await storedUser(page);
  expect(user?.isAnonymous).toBe(true);
  expect(user?.uid).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket connected', { timeout: 60_000 });
  expect((await storedUser(page))?.uid).toBe(user.uid);
  await page.getByRole('button', { name: 'Check backend' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend health status' }),
  ).toContainText('Backend ok', {
    timeout: 60_000,
  });
});

test('streams microphone audio to the authenticated server and releases capture on Stop', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Fake microphone hardware is configured for Chromium.',
  );
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      when?: number,
      offset?: number,
      duration?: number,
    ) {
      const scope = globalThis as typeof globalThis & {
        audioPlaybackStarts?: number;
      };
      scope.audioPlaybackStarts = (scope.audioPlaybackStarts ?? 0) + 1;
      return start.call(this, when, offset, duration);
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      (
        globalThis as typeof globalThis & {
          microphoneTracks: MediaStreamTrack[];
        }
      ).microphoneTracks = stream.getTracks();
      return stream;
    };
  });
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('api.openai.com'))
      externalRequests.push(request.url());
  });
  await page.goto('/');
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket connected');
  await page.getByRole('button', { name: 'Start microphone' }).click();
  const status = page.getByRole('status', { name: 'Microphone status' });
  await expect(status).toContainText(
    /Microphone streaming · Audio received by server/,
    { timeout: 15000 },
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
            .audioPlaybackStarts ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(status).toContainText('Microphone idle');
  expect(
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          microphoneTracks: MediaStreamTrack[];
        }
      ).microphoneTracks.every((track) => track.readyState === 'ended'),
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Start microphone' }).click();
  await expect(status).toContainText(
    /Microphone streaming · Audio received by server/,
    { timeout: 15000 },
  );
  await page.getByRole('button', { name: 'Stop microphone' }).click();
  await expect(status).toContainText('Microphone idle');
  expect(externalRequests).toEqual([]);
});

test('explains unsupported microphone capability without requesting permission', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'AudioWorkletNode', { value: undefined });
  });
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Start microphone' }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      'Microphone streaming requires Web Audio and microphone access on HTTPS or localhost.',
    ),
  ).toBeVisible();
});
