import { test, expect, type Page } from '@playwright/test';

async function storedUser(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{
        uid: string;
        isAnonymous: boolean;
        stsTokenManager: { accessToken: string };
      }>((resolve, reject) => {
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
  ).toHaveText('Socket on', { timeout: 60_000 });
  const user = await storedUser(page);
  expect(user?.isAnonymous).toBe(true);
  expect(user?.uid).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on', { timeout: 60_000 });
  expect((await storedUser(page))?.uid).toBe(user.uid);
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
  ).toHaveText('Socket on');
  await page.getByRole('button', { name: /Start session|Resume/ }).click();
  const status = page.getByRole('status', { name: 'Microphone status' });
  await expect(status).toContainText(/Listening · Speak to the assistant/, {
    timeout: 15000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
            .audioPlaybackStarts ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByText('Hello from the resident.').first(),
  ).toBeVisible();
  await expect(page.getByText('Hello! How can I help?').first()).toBeVisible();
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(status).toContainText(
    'Start a session to talk with the assistant.',
  );
  expect(
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & {
          microphoneTracks: MediaStreamTrack[];
        }
      ).microphoneTracks.every((track) => track.readyState === 'ended'),
    ),
  ).toBe(true);
  const previousPlaybackStarts = await page.evaluate(
    () =>
      (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
        .audioPlaybackStarts ?? 0,
  );
  await page.getByRole('button', { name: /Start session|Resume/ }).click();
  await expect(status).toContainText(/Listening · Speak to the assistant/, {
    timeout: 15000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
            .audioPlaybackStarts ?? 0,
      ),
    )
    .toBeGreaterThan(previousPlaybackStarts);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(status).toContainText(
    'Start a session to talk with the assistant.',
  );
  await page.getByRole('button', { name: 'End call' }).click();
  await expect(page.getByRole('status', { name: 'Call status' })).toHaveText(
    'Call saved',
    { timeout: 15000 },
  );
  const user = await storedUser(page);
  const headers = {
    Authorization: `Bearer ${user.stsTokenManager.accessToken}`,
  };
  const root =
    'http://127.0.0.1:8380/v1/projects/demo-living-community-assistant/databases/(default)/documents';
  const calls = await fetch(`${root}/sessions/${user.uid}/calls`, {
    headers,
  }).then((response) => response.json());
  expect(calls.documents).toHaveLength(1);
  const saved = calls.documents[0];
  expect(saved.fields.recordingStatus.stringValue).toBe('saved');
  expect(saved.fields.uid.stringValue).toBe(user.uid);
  const recording = saved.fields.recording.mapValue.fields;
  const audio = await fetch(
    `http://127.0.0.1:9398/v0/b/${recording.bucket.stringValue}/o/${encodeURIComponent(recording.objectPath.stringValue)}?alt=media`,
    { headers },
  );
  expect(audio.ok).toBe(true);
  const wav = Buffer.from(await audio.arrayBuffer());
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.length).toBeGreaterThan(44);
  const transcript = await fetch(
    `http://127.0.0.1:8380/v1/${saved.name}/transcripts`,
    { headers },
  ).then((response) => response.json());
  expect(
    transcript.documents.some(
      (entry: { fields: { role: { stringValue: string } } }) =>
        entry.fields.role.stringValue === 'user',
    ),
  ).toBe(true);
  expect(
    transcript.documents.some(
      (entry: { fields: { role: { stringValue: string } } }) =>
        entry.fields.role.stringValue === 'assistant',
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.getByRole('status', { name: 'Call status' })).toHaveText(
    'Call active',
  );
  await expect(page.getByText('Hello from the resident.')).toHaveCount(1);
  await page.getByRole('button', { name: 'End call' }).click();
  await expect(page.getByRole('status', { name: 'Call status' })).toHaveText(
    'Call saved',
  );
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
    page.getByRole('button', { name: 'Start session' }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      'Microphone streaming requires Web Audio and microphone access on HTTPS or localhost.',
    ),
  ).toBeVisible();
});
