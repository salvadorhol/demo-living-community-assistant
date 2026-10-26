import {test, expect} from '@playwright/test';
import {initializeApp, deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';

const projectId = 'demo-living-community-assistant';
const uid = 'review-fixture-visitor';
const callId = 'review-fixture-call';
const path = `sessions/${uid}/calls/${callId}`;
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8380';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9398';
const app = initializeApp({projectId}, 'review-browser-test');
const database = getFirestore(app);
const call = database.doc(path);
const recording = getStorage(app)
  .bucket(`${projectId}.firebasestorage.app`)
  .file(`${path}/recording.wav`);

test.beforeAll(async () => {
  const pcmBytes = 180 * 48000; // Three minutes: above the old 6 MiB inline limit.
  const audio = Buffer.alloc(44 + pcmBytes);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(24000, 24);
  audio.writeUInt32LE(48000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(pcmBytes, 40);
  await recording.save(audio, {metadata: {contentType: 'audio/wav'}});
  await call.set({
    uid,
    startedAt: '2026-10-25T12:00:00Z',
    endedAt: '2026-10-25T12:03:00Z',
    status: 'ended',
    recordingStatus: 'saved',
    transcriptionStatus: 'available',
    recording: {
      bucket: `${projectId}.firebasestorage.app`,
      objectPath: `${path}/recording.wav`,
      durationMs: 180000,
    },
  });
  await call.collection('transcripts').doc('visitor-turn').set({
    role: 'user',
    text: 'Can I schedule a tour for my mother?',
    isFinal: true,
    order: 0,
  });
  await call.collection('transcripts').doc('sophie-turn').set({
    role: 'assistant',
    text: 'I can help you request a tour.',
    isFinal: true,
    order: 1,
  });
});
test.afterAll(async () => {
  await database.recursiveDelete(call);
  await recording.delete();
  await deleteApp(app);
});
for (const width of [1280, 390]) {
  test(`reviews stored calls and plays audio at ${width}px`, async ({page}) => {
    await call.update({
      latestReviewId: null,
      latestReviewScore: null,
      reviewAttemptId: null,
    });
    await page.setViewportSize({width, height: 720});
    await page.goto('/admin/review');
    await page
      .getByLabel('Password', {exact: true})
      .fill('fixture-admin-password');
    await page.getByRole('button', {name: 'Unlock', exact: true}).click();
    await page.getByRole('link', {name: /180 seconds/}).click();
    await expect(page).toHaveURL(new RegExp(`/admin/review/${uid}/${callId}$`));
    await expect(
      page.getByText('Can I schedule a tour for my mother?')
    ).toBeVisible();
    await page.getByRole('button', {name: 'Load audio', exact: true}).click();
    const audio = page.locator('audio');
    await expect(audio).toHaveJSProperty('readyState', 4);
    await expect(audio).toHaveAttribute('src', /^blob:/);
    await expect(audio).toHaveJSProperty('duration', 180);
    await audio.evaluate((node: HTMLAudioElement) => {
      node.currentTime = 120;
    });
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
      .toBeGreaterThanOrEqual(120);
    await audio.evaluate((node: HTMLAudioElement) => node.play());
    await expect
      .poll(() => audio.evaluate((node: HTMLAudioElement) => node.currentTime))
      .toBeGreaterThan(0);
    await page.getByLabel('Playback speed').selectOption('1.5');
    await expect(audio).toHaveJSProperty('playbackRate', 1.5);
    // The model boundary is mocked; listing, audio, detail and persisted results use real emulators.
    await page.route('**/generateCallReview', async route => {
      const result = {
        overallScore: 4,
        summary: 'Warm, concise assistance.',
        strengths: ['Respectful language'],
        limitations: ['Transcription only'],
        categories: [
          {
            name: 'Warmth and empathy',
            score: 4,
            explanation: 'A helpful response.',
            evidenceIds: ['sophie-turn'],
          },
        ],
        suggestions: [
          {
            priority: 'medium',
            target: 'instructions',
            observation: 'Next steps could be clearer.',
            recommendation: 'Explain staff confirmation.',
            suggestedWording:
              'Explain that tour requests await staff confirmation.',
            evidenceIds: ['sophie-turn'],
          },
        ],
      };
      const attempt = {
        id: 'browser-review',
        status: 'succeeded',
        model: 'gpt-6-luna',
        rubricVersion: 'senior-living-v1',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        leaseUntil: 0,
        result,
      };
      await call.collection('reviews').doc(attempt.id).set(attempt);
      await call.update({
        latestReviewId: attempt.id,
        reviewAttemptId: attempt.id,
        latestReviewScore: 4,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {'access-control-allow-origin': '*'},
        body: JSON.stringify({data: attempt}),
      });
    });
    await page
      .getByRole('button', {name: 'Generate review', exact: true})
      .click();
    await expect(
      page.getByRole('heading', {name: 'Overall score: 4/5'})
    ).toBeVisible();
    await page
      .getByRole('button', {name: 'Show transcript evidence'})
      .first()
      .click();
    await expect(
      page.getByText('I can help you request a tour.')
    ).toBeInViewport();
    await page.reload();
    await expect(page.getByText('Warm, concise assistance.')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
    await page.getByRole('link', {name: 'All calls'}).click();
    await expect(
      page.getByRole('link', {name: /180 seconds.*4\/5/})
    ).toBeVisible();
  });
}

test('admin delete button removes a call subtree and storage prefix while preserving shared data', async ({
  page,
}) => {
  const deleteUid = 'delete-fixture-visitor';
  const deleteId = 'delete-target';
  const root = `sessions/${deleteUid}/calls/${deleteId}`;
  const target = database.doc(root);
  const sibling = database.doc(`${root}-sibling`);
  const session = database.doc(`sessions/${deleteUid}`);
  const followUp = session.collection('followUpRequests').doc('shared-request');
  const bucket = getStorage(app).bucket(`${projectId}.firebasestorage.app`);
  const files = [
    `${root}/recording.wav`,
    `${root}/extra/audio.wav`,
    `${root}-sibling/recording.wav`,
  ];
  try {
    await session.set({contact: {profile: {firstName: 'Fixture'}}});
    await followUp.set({status: 'pending'});
    await sibling.set({status: 'ended', startedAt: '2026-10-25T13:00:00Z'});
    await target.set({
      status: 'ended',
      recordingStatus: 'saved',
      startedAt: '2026-10-25T12:00:00Z',
      recording: {bucket: bucket.name, objectPath: `${root}/recording.wav`},
    });
    await target.collection('transcripts').doc('turn').set({text: 'Fixture'});
    await target
      .collection('transcripts')
      .doc('turn')
      .collection('annotations')
      .doc('note')
      .set({note: 'Fixture'});
    await target.collection('reviews').doc('review').set({status: 'succeeded'});
    await Promise.all(
      files.map(path => bucket.file(path).save(Buffer.from('fixture')))
    );
    await page.goto('/admin/review');
    await page
      .getByLabel('Password', {exact: true})
      .fill('fixture-admin-password');
    await page.getByRole('button', {name: 'Unlock', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Review', exact: true})
    ).toBeVisible();
    const invoke = () =>
      page.evaluate(
        async ({uid, callId}) => {
          const key = Object.keys(localStorage).find(key =>
            key.startsWith('firebase:authUser:')
          );
          if (!key) throw new Error('Admin identity missing');
          const raw = localStorage.getItem(key);
          if (!raw) throw new Error('Admin identity missing');
          const user = JSON.parse(raw);
          const response = await fetch(
            'http://127.0.0.1:5301/demo-living-community-assistant/us-central1/deleteCall',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${user.stsTokenManager.accessToken}`,
              },
              body: JSON.stringify({data: {uid, callId}}),
            }
          );
          return {status: response.status, body: await response.json()};
        },
        {uid: deleteUid, callId: deleteId}
      );
    const deleteButton = page.getByRole('button', {
      name: /Delete call .*\(delete-target\)/,
    });
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('cannot be undone');
      await dialog.dismiss();
    });
    await deleteButton.click();
    await expect(deleteButton).toBeVisible();
    expect((await target.get()).exists).toBe(true);
    page.once('dialog', dialog => dialog.accept());
    await deleteButton.click();
    await expect(page.getByText('Call deleted.', {exact: true})).toBeVisible();
    await expect(deleteButton).toHaveCount(0);
    expect((await target.get()).exists).toBe(false);
    expect((await target.collection('transcripts').get()).empty).toBe(true);
    expect(
      (
        await target
          .collection('transcripts')
          .doc('turn')
          .collection('annotations')
          .get()
      ).empty
    ).toBe(true);
    expect((await target.collection('reviews').get()).empty).toBe(true);
    expect((await bucket.getFiles({prefix: `${root}/`}))[0]).toHaveLength(0);
    expect((await sibling.get()).exists).toBe(true);
    expect(
      (await bucket.file(`${root}-sibling/recording.wav`).exists())[0]
    ).toBe(true);
    expect((await session.get()).get('contact.profile.firstName')).toBe(
      'Fixture'
    );
    expect((await followUp.get()).exists).toBe(true);
    expect((await invoke()).status).toBe(200);
  } finally {
    await database.recursiveDelete(session);
    await Promise.all(
      files.map(path => bucket.file(path).delete({ignoreNotFound: true}))
    );
  }
});
