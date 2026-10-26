import { test, expect, type Page } from '@playwright/test';

async function storedUser(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((key) =>
      key.startsWith('firebase:authUser:'),
    );
    return key
      ? (JSON.parse(localStorage.getItem(key)!) as {
          uid: string;
          isAnonymous: boolean;
          stsTokenManager: { accessToken: string };
        })
      : undefined;
  });
}

test('shows the workspace and connects to the backend', async ({ page }) => {
  await page.goto('/');
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Living Community Assistant',
  );
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on', { timeout: 60_000 });
  const user = await storedUser(page);
  expect(user?.isAnonymous).toBe(false);
  expect(user?.uid).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on', { timeout: 60_000 });
  expect((await storedUser(page))?.uid).toBe(user!.uid);
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
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on');
  await page.getByRole('button', { name: /Start session|Resume/ }).click();
  const status = page.getByRole('status', { name: 'Microphone status' });
  await expect(status).toContainText(/Listening · Speak to the assistant/, {
    timeout: 15000,
  });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
              .audioPlaybackStarts ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByText('Hello from the resident.').first(),
  ).toBeVisible();
  await expect(page.getByText('Hello! How can I help?').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page
      .getByText(
        /Available floor plans: Studio, 1 Bedroom \/ 1 Bath, 2 Bedroom \/ 1.5 Bath/,
      )
      .first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText(/Available tour slots: \d{4}-\d{2}-\d{2}T/).first(),
  ).toBeVisible();
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
    .poll(
      () =>
        page.evaluate(
          () =>
            (globalThis as typeof globalThis & { audioPlaybackStarts?: number })
              .audioPlaybackStarts ?? 0,
        ),
      { timeout: 20_000 },
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
    Authorization: `Bearer ${user!.stsTokenManager.accessToken}`,
  };
  const root =
    'http://127.0.0.1:8380/v1/projects/demo-living-community-assistant/databases/(default)/documents';
  const calls = await fetch(`${root}/sessions/${user!.uid}/calls`, {
    headers,
  }).then((response) => response.json());
  expect(calls.documents).toHaveLength(1);
  const saved = calls.documents[0];
  expect(saved.fields.recordingStatus.stringValue).toBe('saved');
  expect(saved.fields.uid.stringValue).toBe(user!.uid);
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
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start session' }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      'Microphone streaming requires Web Audio and microphone access on HTTPS or localhost.',
    ),
  ).toBeVisible();
});

test('requires the password before connecting and locks again on sign-out', async ({
  page,
}) => {
  const sockets: string[] = [];
  page.on('websocket', (socket) => {
    if (socket.url().includes('/socket.io/')) sockets.push(socket.url());
  });
  await page.goto('/');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start session/ })).toHaveCount(
    0,
  );
  expect(sockets).toHaveLength(0);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  expect(sockets).toHaveLength(0);
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
});

test('admin password edits the private prompt, persists it, and signs out', async ({
  page,
}) => {
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Enter the admin password' }),
  ).toBeVisible();
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Incorrect password');
  await expect(page.getByLabel('Sophie’s prompt')).toHaveCount(0);
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-admin-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  const editor = page.getByLabel('Sophie’s prompt');
  await expect(editor).toBeVisible();
  const original = await editor.inputValue();
  const edited = original + '\nAdmin browser test instruction.';
  await editor.fill(edited);
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(
    page.getByText('Prompt saved. New calls will use the saved version.'),
  ).toBeVisible();
  await page.reload();
  await expect(editor).toHaveValue(edited);
  const other = await page.context().newPage();
  await other.goto('/admin');
  await expect(other.getByLabel('Sophie’s prompt')).toBeVisible();
  await other
    .getByLabel('Sophie’s prompt')
    .fill(edited + '\nOther admin draft.');
  await editor.fill(original);
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(
    page.getByText('Prompt saved. New calls will use the saved version.'),
  ).toBeVisible();
  await other.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText(
    'Another admin changed this prompt',
  );
  await expect(other.getByLabel('Sophie’s prompt')).toHaveValue(
    edited + '\nOther admin draft.',
  );
  // Sign-out from this tab must clear the other tab's private editor and draft.
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(other.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(other.getByLabel('Sophie’s prompt')).toHaveCount(0);
  await other.close();
});

test('an ordinary app session cannot open the prompt editor', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-access-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Socket connection status' }),
  ).toHaveText('Socket on');
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { name: 'Enter the admin password' }),
  ).toBeVisible();
  await expect(page.getByLabel('Sophie’s prompt')).toHaveCount(0);
});

test('edits appointment JSON and completes a disclosed sales handoff after playback', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Fake microphone hardware is configured for Chromium.',
  );
  await page.context().grantPermissions(['microphone']);
  await page.goto('/admin');
  await page
    .getByLabel('Password', { exact: true })
    .fill('fixture-admin-password');
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  const editor = page.getByLabel('Appointments JSON');
  await expect(editor).toBeVisible();
  const original = await editor.inputValue();
  await editor.fill('{');
  await expect(
    page.getByRole('button', { name: 'Save appointments', exact: true }),
  ).toBeDisabled();
  await editor.fill('[]');
  await page
    .getByRole('button', { name: 'Save appointments', exact: true })
    .click();
  await expect(
    page.getByText(
      'Appointments saved. The next lookup will use these options.',
    ),
  ).toBeVisible();
  const visitor = await page.context().newPage();
  try {
    await visitor.addInitScript(() => {
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
        navigator.mediaDevices,
      );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await getUserMedia(constraints);
        (
          globalThis as typeof globalThis & {
            handoffTracks: MediaStreamTrack[];
          }
        ).handoffTracks = stream.getTracks();
        return stream;
      };
    });
    await visitor.goto('/');
    await expect(
      visitor.getByRole('status', { name: 'Socket connection status' }),
    ).toHaveText('Socket on');
    await visitor
      .getByRole('button', { name: 'Start session', exact: true })
      .click();
    await expect(
      visitor.getByText(/For this demo, I will simulate a sales transfer/),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      visitor.getByRole('status', { name: 'Call status' }),
    ).toHaveText('Demo transfer complete. Call ended and saved.', {
      timeout: 20000,
    });
    expect(
      await visitor.evaluate(() =>
        (
          globalThis as typeof globalThis & {
            handoffTracks: MediaStreamTrack[];
          }
        ).handoffTracks.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    const user = await storedUser(visitor);
    const response = await visitor.request.get(
      `http://127.0.0.1:8380/v1/projects/demo-living-community-assistant/databases/(default)/documents/sessions/${user!.uid}/calls`,
      {
        headers: {
          Authorization: `Bearer ${user!.stsTokenManager.accessToken}`,
        },
      },
    );
    expect(response.ok()).toBe(true);
    const calls = await response.json();
    expect(
      calls.documents.some(
        (call: { fields: { endReason?: { stringValue: string } } }) =>
          call.fields.endReason?.stringValue === 'demo_sales_handoff',
      ),
    ).toBe(true);
  } finally {
    await visitor.close();
    await editor.fill(original);
    await page
      .getByRole('button', { name: 'Save appointments', exact: true })
      .click();
    await expect(
      page.getByText(
        'Appointments saved. The next lookup will use these options.',
      ),
    ).toBeVisible();
  }
});
