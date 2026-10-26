import {createHash, randomUUID} from 'node:crypto';
import {getApps, initializeApp} from 'firebase-admin/app';
import {FieldPath, getFirestore} from 'firebase-admin/firestore';
import {getStorage} from 'firebase-admin/storage';
import {defineSecret} from 'firebase-functions/params';
import {
  HttpsError,
  onCall,
  type CallableRequest,
} from 'firebase-functions/v2/https';
import type {
  ReviewCallSummary,
  TranscriptUpdate,
  ReviewAttempt,
} from '@living-community-assistant/types';
import {
  REVIEW_MODEL,
  RUBRIC_VERSION,
  REVIEW_INSTRUCTIONS,
  reviewSchema,
  validateReview,
} from './review-assessment';
const apiKey = defineSecret('OPENAI_API_KEY');
const options = {region: 'us-central1', maxInstances: 2} as const;
const db = () => getFirestore(getApps()[0] ?? initializeApp());
export function requireReviewAdmin(request: Pick<CallableRequest, 'auth'>) {
  if (!request.auth)
    throw new HttpsError('unauthenticated', 'Admin sign-in required.');
  if (request.auth.token.admin !== true)
    throw new HttpsError('permission-denied', 'Admin access required.');
  return request.auth.uid;
}
function callRef(data: unknown) {
  const d = data as Record<string, unknown> | null;
  if (
    !d ||
    ![d.uid, d.callId].every(
      v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v)
    )
  )
    throw new HttpsError('invalid-argument', 'Invalid call.');
  return db().doc(`sessions/${d.uid}/calls/${d.callId}`);
}
interface StoredCall {
  startedAt?: string;
  endedAt?: string;
  status?: string;
  recordingStatus?: string;
  recording?: {durationMs?: number};
  transcriptionStatus?: string;
  latestReviewScore?: number | null;
}
function summary(path: string, d: StoredCall): ReviewCallSummary {
  const parts = path.split('/');
  return {
    uid: parts[1],
    callId: parts[3],
    startedAt: d.startedAt ?? '',
    endedAt: d.endedAt ?? null,
    status: d.status ?? 'unknown',
    recordingStatus: d.recordingStatus ?? 'pending',
    durationMs: d.recording?.durationMs ?? null,
    transcriptionStatus: d.transcriptionStatus ?? 'available',
    latestReviewScore: d.latestReviewScore ?? null,
  };
}
async function existing(ref: ReturnType<typeof callRef>) {
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpsError('not-found', 'Call not found.');
  return snapshot.data() ?? {};
}
async function transcripts(
  ref: ReturnType<typeof callRef>
): Promise<TranscriptUpdate[]> {
  const snapshot = await ref.collection('transcripts').get();
  return snapshot.docs
    .map(d => ({...d.data(), id: d.id}) as TranscriptUpdate)
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) -
          (b.order ?? Number.MAX_SAFE_INTEGER) ||
        (a.createdAt ?? '').localeCompare(b.createdAt ?? '') ||
        a.id.localeCompare(b.id)
    );
}
export const listReviewCalls = onCall(options, async request => {
  requireReviewAdmin(request);
  const {cursor, limit = 25} = request.data ?? {};
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new HttpsError('invalid-argument', 'Invalid page size.');
  let query = db()
    .collectionGroup('calls')
    .orderBy('startedAt', 'desc')
    .orderBy(FieldPath.documentId(), 'desc');
  if (cursor) {
    if (
      typeof cursor.startedAt !== 'string' ||
      typeof cursor.path !== 'string' ||
      !/^sessions\/[A-Za-z0-9_-]{1,128}\/calls\/[A-Za-z0-9_-]{1,128}$/.test(
        cursor.path
      )
    )
      throw new HttpsError('invalid-argument', 'Invalid cursor.');
    query = query.startAfter(cursor.startedAt, db().doc(cursor.path));
  }
  const result = await query.limit(limit + 1).get();
  const page = result.docs.slice(0, limit);
  const last = page.at(-1);
  return {
    calls: page.map(d => summary(d.ref.path, d.data())),
    nextCursor:
      result.size > limit && last
        ? {startedAt: last.get('startedAt'), path: last.ref.path}
        : null,
  };
});
export const getReviewCall = onCall(options, async request => {
  requireReviewAdmin(request);
  const ref = callRef(request.data);
  const data = await existing(ref);
  const [entries, attempt, latest] = await Promise.all([
    transcripts(ref),
    data.reviewAttemptId
      ? ref.collection('reviews').doc(data.reviewAttemptId).get()
      : null,
    data.latestReviewId
      ? ref.collection('reviews').doc(data.latestReviewId).get()
      : null,
  ]);
  return {
    ...summary(ref.path, data),
    transcripts: entries,
    attempt: attempt?.data() ?? null,
    latestReview: latest?.data() ?? null,
  };
});
function recordingStorage() {
  const app = getApps()[0] ?? initializeApp();
  const projectId = app.options.projectId ?? process.env.GCLOUD_PROJECT;
  const emulator =
    process.env.FUNCTIONS_EMULATOR === 'true' &&
    !!process.env.FIREBASE_STORAGE_EMULATOR_HOST;
  const allowedBuckets = new Set([
    process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
      `${projectId}-call-recordings`,
    ...(emulator ? [`${projectId}.firebasestorage.app`] : []),
  ]);
  return {app, emulator, allowedBuckets};
}
export const getReviewAudio = onCall(options, async request => {
  requireReviewAdmin(request);
  const ref = callRef(request.data);
  const data = await existing(ref);
  const {app, emulator, allowedBuckets} = recordingStorage();
  const bucket: unknown = data.recording?.bucket;
  if (
    data.status === 'deleting' ||
    data.recordingStatus !== 'saved' ||
    typeof bucket !== 'string' ||
    !allowedBuckets.has(bucket) ||
    data.recording?.objectPath !== `${ref.path}/recording.wav`
  )
    throw new HttpsError('failed-precondition', 'Recording unavailable.');
  const file = getStorage(app).bucket(bucket).file(data.recording.objectPath);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  // Local emulators have no signing identity. Return small test recordings inline.
  if (emulator) {
    const [metadata] = await file.getMetadata();
    if (Number(metadata.size) > 6 * 1024 * 1024)
      throw new HttpsError(
        'resource-exhausted',
        'Emulator playback supports recordings up to 6 MB.'
      );
    const [audio] = await file.download();
    return {
      url: `data:audio/wav;base64,${audio.toString('base64')}`,
      expiresAt,
    };
  }
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: expiresAt,
  });
  return {url, expiresAt};
});
export const generateCallReview = onCall(
  {...options, secrets: [apiKey], timeoutSeconds: 180},
  async request => {
    const requestedBy = requireReviewAdmin(request);
    if (
      request.data?.regenerate !== undefined &&
      typeof request.data.regenerate !== 'boolean'
    )
      throw new HttpsError('invalid-argument', 'Invalid regeneration option.');
    const ref = callRef(request.data);
    const data = await existing(ref);
    if (data.status !== 'ended')
      throw new HttpsError(
        'failed-precondition',
        'Wait for the call to finish.'
      );
    const entries = await transcripts(ref);
    const evidence = entries.map(
      ({id, role, text, interrupted, incomplete, isFinal}) => ({
        id,
        role,
        text,
        interrupted: !!interrupted,
        incomplete: !!incomplete || !isFinal,
      })
    );
    const input = JSON.stringify(evidence);
    if (
      !entries.some(t => t.role === 'user' && t.text.trim()) ||
      !entries.some(t => t.role === 'assistant' && t.text.trim())
    )
      throw new HttpsError(
        'failed-precondition',
        'Insufficient transcript evidence to review.'
      );
    if (Buffer.byteLength(input) > 300000)
      throw new HttpsError(
        'resource-exhausted',
        'Transcript exceeds the review size limit.'
      );
    const fingerprint = createHash('sha256').update(input).digest('hex');
    const id = randomUUID();
    const attempt: ReviewAttempt = {
      id,
      status: 'running',
      startedAt: new Date().toISOString(),
      leaseUntil: Date.now() + 240000,
      model: REVIEW_MODEL,
      rubricVersion: RUBRIC_VERSION,
      transcriptFingerprint: fingerprint,
      requestedBy,
    };
    const attemptRef = ref.collection('reviews').doc(id);
    const cached = await db().runTransaction(async tx => {
      const current = (await tx.get(ref)).data();
      if (!current) throw new HttpsError('not-found', 'Call not found.');
      if (current.status !== 'ended')
        throw new HttpsError(
          'failed-precondition',
          'Call is not available for review.'
        );
      if (current.reviewLeaseUntil > Date.now())
        throw new HttpsError('already-exists', 'A review is already running.');
      if (!request.data.regenerate && current.latestReviewId) {
        const saved = (
          await tx.get(ref.collection('reviews').doc(current.latestReviewId))
        ).data();
        if (
          saved?.transcriptFingerprint === fingerprint &&
          saved.rubricVersion === RUBRIC_VERSION
        )
          return saved;
      }
      tx.set(attemptRef, attempt);
      tx.update(ref, {
        reviewAttemptId: id,
        reviewLeaseUntil: attempt.leaseUntil,
      });
      return null;
    });
    if (cached) return cached;
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
        headers: {
          Authorization: `Bearer ${apiKey.value()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: REVIEW_MODEL,
          store: false,
          instructions: REVIEW_INSTRUCTIONS,
          input,
          max_output_tokens: 6000,
          text: {
            format: {
              type: 'json_schema',
              name: 'call_review',
              strict: true,
              schema: reviewSchema,
            },
          },
        }),
      });
      if (!response.ok) throw new Error('Provider unavailable');
      const body = (await response.json()) as {
        status?: string;
        output?: {content?: {type: string; text?: string}[]}[];
      };
      if (body.status !== 'completed') throw new Error('Incomplete review');
      const output = body.output
        ?.flatMap(o => o.content ?? [])
        .filter(c => c.type === 'output_text')
        .map(c => c.text ?? '')
        .join('');
      const result = validateReview(JSON.parse(output ?? ''), entries);
      const finished = {
        ...attempt,
        status: 'succeeded' as const,
        finishedAt: new Date().toISOString(),
        result,
      };
      await db().runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (!current) throw new HttpsError('not-found', 'Call not found.');
        if (current.status !== 'ended' || current.reviewAttemptId !== id)
          throw new Error('Review superseded');
        tx.set(attemptRef, finished);
        tx.update(ref, {
          latestReviewId: id,
          latestReviewScore: result.overallScore,
          reviewLeaseUntil: 0,
        });
      });
      return finished;
    } catch {
      await db().runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        // A timed-out review must never recreate a deleted call's subcollections.
        if (
          !current ||
          current.status !== 'ended' ||
          current.reviewAttemptId !== id
        )
          return;
        tx.set(attemptRef, {
          ...attempt,
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: 'Could not generate review. Please retry.',
        });
        if (current?.reviewAttemptId === id)
          tx.update(ref, {reviewLeaseUntil: 0});
      });
      throw new HttpsError(
        'unavailable',
        'Could not generate review. Please retry.'
      );
    }
  }
);

/** Deletes only this call's namespace; session-level contact/follow-up data is shared. */
export const deleteCall = onCall(
  {...options, timeoutSeconds: 540},
  async request => {
    requireReviewAdmin(request);
    const ref = callRef(request.data);
    const {app, allowedBuckets} = recordingStorage();
    const id = randomUUID();
    const prefix = `${ref.path}/`;
    await db().runTransaction(async tx => {
      const snapshot = await tx.get(ref);
      const current = snapshot.data();
      // Retrying after a partial recursive delete must also clean orphan subcollections.
      if (!current) return;
      if (current.status !== 'ended' && current.status !== 'deleting')
        throw new HttpsError(
          'failed-precondition',
          'End the call and wait for saving to finish before deleting it.'
        );
      if (current.reviewLeaseUntil > Date.now())
        throw new HttpsError(
          'failed-precondition',
          'Wait for the running review to finish before deleting the call.'
        );
      if (current.deletionLeaseUntil > Date.now())
        throw new HttpsError(
          'already-exists',
          'Call deletion is already running.'
        );
      if (
        current.recording &&
        (!allowedBuckets.has(current.recording.bucket) ||
          typeof current.recording.objectPath !== 'string' ||
          !current.recording.objectPath.startsWith(prefix))
      )
        throw new HttpsError(
          'failed-precondition',
          'The recording reference is outside this call.'
        );
      tx.update(ref, {
        status: 'deleting',
        deletionId: id,
        deletionLeaseUntil: Date.now() + 600000,
      });
    });
    try {
      // Exact slash-terminated prefix prevents matching another call with a similar ID.
      // Storage first: a storage failure leaves a retryable call document behind.
      for (const bucket of allowedBuckets) {
        try {
          await getStorage(app)
            .bucket(bucket)
            .deleteFiles({prefix, force: true});
        } catch (error) {
          // A configured bucket may not exist yet in a fresh emulator/project.
          if (
            !error ||
            typeof error !== 'object' ||
            !('code' in error) ||
            error.code !== 404
          )
            throw error;
        }
      }
      await db().recursiveDelete(ref);
      return {
        uid: request.data.uid,
        callId: request.data.callId,
        deleted: true as const,
      };
    } catch {
      await db().runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (current?.deletionId === id) tx.update(ref, {deletionLeaseUntil: 0});
      });
      throw new HttpsError(
        'unavailable',
        'Call deletion could not finish. Retry to complete cleanup.'
      );
    }
  }
);
