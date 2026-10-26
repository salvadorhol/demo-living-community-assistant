import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const require = createRequire(import.meta.url);
const functions = require(resolve('dist/functions/main.cjs'));
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8180';
const admin = initializeApp(
  { projectId: 'demo-living-community-assistant' },
  'profile-smoke',
);
const db = getFirestore(admin);
const uid = `profile-${randomUUID()}`;
const other = `other-${randomUUID()}`;
const base =
  'http://127.0.0.1:5101/demo-living-community-assistant/us-central1';
const id = (text) => createHash('sha256').update(text).digest('hex');
async function call(name, body, status = 200) {
  assert.deepEqual(functions[name].__endpoint.httpsTrigger.invoker, [
    'private',
  ]);
  const response = await fetch(`${base}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(
    response.status,
    status,
    `${name} expected ${status}, got ${response.status}`,
  );
  return response.json();
}
try {
  assert.deepEqual(await call('getContactInformation', { uid }), {
    profile: {},
  });
  await db
    .doc(`sessions/${uid}`)
    .set({ uid, provider: 'anonymous', existingMetadata: true });
  const save = {
    uid,
    requestId: id('contact-' + uid),
    confirmed: true,
    profile: { firstName: 'James', email: 'james@example.com' },
  };
  assert.equal(
    (await call('saveContactInformation', save)).profile.firstName,
    'James',
  );
  assert.equal(
    (await db.doc(`sessions/${uid}`).get()).get('contact.consent'),
    undefined,
  );
  // Legacy receipt flags must not leak back into the current API contract.
  await db
    .doc(`sessions/${uid}/toolWrites/${save.requestId}`)
    .update({ 'result.consent': true });
  assert.deepEqual(
    await call('saveContactInformation', save),
    await call('getContactInformation', { uid }),
  );
  await call(
    'saveContactInformation',
    { ...save, profile: { firstName: 'Different' } },
    409,
  );
  await call('saveContactInformation', {
    ...save,
    requestId: id('last-' + uid),
    profile: { lastName: 'Smith' },
  });
  const profile = await call('getContactInformation', { uid });
  assert.deepEqual(profile.profile, {
    firstName: 'James',
    lastName: 'Smith',
    email: 'james@example.com',
  });
  assert.equal(
    (await db.doc(`sessions/${uid}`).get()).get('existingMetadata'),
    true,
  );
  assert.deepEqual(await call('getContactInformation', { uid: other }), {
    profile: {},
  });
  await call('getContactInformation', { uid: '../other' }, 400);
  await call('saveContactInformation', { ...save, confirmed: false }, 400);
  await call(
    'saveContactInformation',
    { ...save, profile: { phone: 'guess' } },
    400,
  );
  const slots = await call('getAvailableAppointments', { date: 'next Monday' });
  await db.doc(`sessions/${uid}`).update({ 'contact.consent': false });
  const request = {
    uid,
    requestId: id('tour-' + uid),
    confirmed: true,
    request: {
      kind: 'tour',
      date: slots.requestedDate,
      slotId: slots.appointments[0].id,
    },
  };
  const result = await call('createFollowUpRequest', request);
  assert.equal(result.status, 'pending');
  assert.deepEqual(await call('createFollowUpRequest', request), result);
  assert.equal(
    (await db.collection(`sessions/${uid}/followUpRequests`).get()).size,
    1,
  );
  await call(
    'createFollowUpRequest',
    {
      ...request,
      requestId: id('bad-' + uid),
      request: { ...request.request, slotId: 'invented' },
    },
    409,
  );
  await call(
    'createFollowUpRequest',
    {
      uid: other,
      requestId: id('no-contact-' + uid),
      confirmed: true,
      request: { kind: 'callback', preferredTime: 'Tomorrow afternoon' },
    },
    409,
  );
  await call('createFollowUpRequest', {
    uid,
    requestId: id('callback-' + uid),
    confirmed: true,
    request: { kind: 'callback', preferredTime: 'Tomorrow afternoon' },
  });
  for (const legacy of [false, true]) {
    await db.doc(`sessions/${uid}`).update({ 'contact.consent': legacy });
    const remembered = await call('getContactInformation', { uid });
    assert.equal(remembered.profile.firstName, 'James');
    assert.equal(Object.hasOwn(remembered, 'consent'), false);
    await call('createFollowUpRequest', {
      uid,
      requestId: id(`legacy-${legacy}-${uid}`),
      confirmed: true,
      request: { kind: 'callback', preferredTime: 'Tomorrow afternoon' },
    });
  }
  for (const category of [
    'pricing',
    'amenities',
    'care',
    'payments',
    'policies',
    'contact',
    'careers',
  ]) {
    const card = await call('getCommunityInformation', { category });
    assert.equal(card.category, category);
    assert.equal(Object.hasOwn(card, 'mock'), false);
  }
  await call('getCommunityInformation', { category: 'invented' }, 400);
  console.log(
    'Profile smoke passed: partial merge, identity separation, confirmation, idempotent pending requests, slot validation, and private community cards.',
  );
} finally {
  await db.recursiveDelete(db.doc(`sessions/${uid}`));
  await deleteApp(admin);
}
