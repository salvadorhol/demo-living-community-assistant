import type {
  ReviewCallDetail,
  ReviewCallPage,
  ReviewAttempt,
} from '@living-community-assistant/types';
import {CATEGORY_NAMES} from './review-assessment';
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  queryGet: vi.fn(),
  signed: vi.fn(),
  metadata: vi.fn(),
  download: vi.fn(),
  deleteFiles: vi.fn(),
  recursiveDelete: vi.fn(),
  set: vi.fn(),
  update: vi.fn(),
  fetch: vi.fn(),
  transactionGet: vi.fn(),
}));
vi.mock('firebase-functions/params', () => ({
  defineSecret: () => ({value: () => 'test-key'}),
}));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {
    constructor(
      public code: string,
      message: string
    ) {
      super(message);
    }
  },
}));
vi.mock('firebase-admin/app', () => ({
  getApps: () => [{options: {projectId: 'demo-test'}}],
}));
vi.mock('firebase-admin/storage', () => ({
  getStorage: () => ({
    bucket: () => ({
      deleteFiles: mocks.deleteFiles,
      file: () => ({
        getSignedUrl: mocks.signed,
        getMetadata: mocks.metadata,
        download: mocks.download,
      }),
    }),
  }),
}));
vi.mock('firebase-admin/firestore', () => {
  const query = {
    orderBy: vi.fn().mockReturnThis(),
    startAfter: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    get: mocks.queryGet,
  };
  const ref = (path: string) => ({
    path,
    get: () => mocks.get(path),
    collection: (name: string) => ({
      get: () => mocks.get(`${path}/${name}`),
      doc: (id: string) => ref(`${path}/${name}/${id}`),
    }),
  });
  return {
    FieldPath: {documentId: () => '__name__'},
    getFirestore: () => ({
      doc: ref,
      collectionGroup: () => query,
      recursiveDelete: mocks.recursiveDelete,
      runTransaction: async (fn: (tx: unknown) => unknown) =>
        fn({get: mocks.transactionGet, set: mocks.set, update: mocks.update}),
    }),
  };
});
import {
  listReviewCalls,
  getReviewCall,
  getReviewAudio,
  generateCallReview,
  deleteCall,
} from './review';
type Handler<T = unknown> = (request: {
  auth?: {uid: string; token: {admin?: boolean}};
  data?: unknown;
}) => Promise<T>;
const handlers = [
  listReviewCalls,
  getReviewCall,
  getReviewAudio,
  generateCallReview,
  deleteCall,
] as unknown as Handler[];
const admin = {uid: 'admin', token: {admin: true}};
const data = {uid: 'visitor', callId: 'call'};
const stored: Record<string, unknown> = {
  startedAt: '2026-10-25T12:00:00Z',
  status: 'ended',
  recordingStatus: 'saved',
  recording: {
    bucket: 'demo-test-call-recordings',
    objectPath: 'sessions/visitor/calls/call/recording.wav',
  },
};
const transcript = [
  {id: 'user', role: 'user', text: 'Tour please', isFinal: true, order: 0},
  {
    id: 'assistant',
    role: 'assistant',
    text: 'Let me check.',
    isFinal: true,
    order: 1,
  },
];
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('FUNCTIONS_EMULATOR', 'false');
  vi.stubEnv('FIREBASE_STORAGE_EMULATOR_HOST', '');
  vi.stubEnv('FIREBASE_STORAGE_BUCKET', '');
  mocks.get.mockImplementation(async (path: string) =>
    path.endsWith('/transcripts')
      ? {docs: [...transcript].reverse().map(t => ({id: t.id, data: () => t}))}
      : {exists: true, data: () => stored}
  );
  mocks.transactionGet.mockImplementation(async () => ({
    data: () => ({...stored, ...mocks.update.mock.calls[0]?.[1]}),
  }));
  mocks.deleteFiles.mockResolvedValue(undefined);
  mocks.recursiveDelete.mockResolvedValue(undefined);
  mocks.queryGet.mockResolvedValue({docs: [], size: 0});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each(handlers)(
  'denies unauthenticated and visitor access to every endpoint',
  async handler => {
    await expect(handler({data})).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(
      handler({auth: {uid: 'visitor', token: {}}, data})
    ).rejects.toMatchObject({code: 'permission-denied'});
    expect(mocks.get).not.toHaveBeenCalled();
  }
);
it('orders transcript entries and returns call details', async () => {
  const result = await (getReviewCall as unknown as Handler<ReviewCallDetail>)({
    auth: admin,
    data,
  });
  expect(result.transcripts.map((t: {id: string}) => t.id)).toEqual([
    'user',
    'assistant',
  ]);
  expect(result.uid).toBe('visitor');
});
it('rejects invalid identifiers and pagination cursors', async () => {
  await expect(
    (getReviewCall as unknown as Handler<ReviewCallDetail>)({
      auth: admin,
      data: {...data, uid: '../other'},
    })
  ).rejects.toMatchObject({code: 'invalid-argument'});
  await expect(
    (listReviewCalls as unknown as Handler<ReviewCallPage>)({
      auth: admin,
      data: {cursor: {startedAt: 'x', path: 'other/path'}},
    })
  ).rejects.toMatchObject({code: 'invalid-argument'});
});
it('paginates across visitor calls using a stable cursor', async () => {
  const docs = ['a', 'b', 'c'].map(uid => ({
    ref: {path: `sessions/${uid}/calls/call`},
    data: () => stored,
    get: () => stored.startedAt,
  }));
  mocks.queryGet.mockResolvedValue({docs, size: 3});
  const result = await (listReviewCalls as unknown as Handler<ReviewCallPage>)({
    auth: admin,
    data: {limit: 2},
  });
  expect(result.calls.map((c: {uid: string}) => c.uid)).toEqual(['a', 'b']);
  expect(result.nextCursor?.path).toBe('sessions/b/calls/call');
});
it('signs only the matching call recording', async () => {
  mocks.signed.mockResolvedValue(['https://example.test/audio']);
  await expect(
    (getReviewAudio as unknown as Handler)({auth: admin, data})
  ).resolves.toMatchObject({url: 'https://example.test/audio'});
  mocks.get.mockResolvedValue({
    exists: true,
    data: () => ({
      ...stored,
      recording: {bucket: 'other', objectPath: 'secret'},
    }),
  });
  await expect(
    (getReviewAudio as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'failed-precondition'});
  expect(mocks.signed).toHaveBeenCalledTimes(1);
});
it('rejects active calls and concurrent generations', async () => {
  mocks.get.mockResolvedValueOnce({
    exists: true,
    data: () => ({...stored, status: 'active'}),
  });
  await expect(
    (generateCallReview as unknown as Handler<ReviewAttempt>)({
      auth: admin,
      data,
    })
  ).rejects.toMatchObject({code: 'failed-precondition'});
  mocks.transactionGet.mockResolvedValue({
    data: () => ({...stored, reviewLeaseUntil: Date.now() + 60000}),
  });
  await expect(
    (generateCallReview as unknown as Handler<ReviewAttempt>)({
      auth: admin,
      data,
    })
  ).rejects.toMatchObject({code: 'already-exists'});
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('saves a validated review and sends transcription only', async () => {
  const result = {
    summary: 'Good',
    strengths: [],
    limitations: ['No audio'],
    categories: CATEGORY_NAMES.map(name => ({
      name,
      score: 4,
      explanation: 'Clear',
      evidenceIds: ['assistant'],
    })),
    suggestions: [],
  };
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        {content: [{type: 'output_text', text: JSON.stringify(result)}]},
      ],
    }),
  });
  mocks.transactionGet.mockImplementation(async () => ({
    data: () => ({
      ...stored,
      reviewAttemptId: mocks.update.mock.calls[0]?.[1]?.reviewAttemptId,
    }),
  }));
  const saved = await (generateCallReview as unknown as Handler<ReviewAttempt>)(
    {
      auth: admin,
      data,
    }
  );
  expect(saved.result?.overallScore).toBe(4);
  const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
  expect(body.model).toBe('gpt-6-luna');
  expect(body.store).toBe(false);
  expect(JSON.parse(body.input)).toHaveLength(2);
  expect(body.input).not.toContain('recording.wav');
  expect(mocks.update).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({latestReviewScore: 4, reviewLeaseUntil: 0})
  );
});
it('records safe failures without overwriting the previous successful result', async () => {
  mocks.fetch.mockRejectedValue(new Error('secret provider details'));
  await expect(
    (generateCallReview as unknown as Handler<ReviewAttempt>)({
      auth: admin,
      data,
    })
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Could not generate review. Please retry.',
  });
  expect(mocks.set).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({status: 'failed'})
  );
  expect(
    mocks.update.mock.calls.every(call => !('latestReviewId' in call[1]))
  ).toBe(true);
});

it('rejects empty and oversized evidence before contacting the provider', async () => {
  mocks.get.mockImplementation(async (path: string) =>
    path.endsWith('/transcripts')
      ? {docs: []}
      : {exists: true, data: () => stored}
  );
  await expect(
    (generateCallReview as unknown as Handler<ReviewAttempt>)({
      auth: admin,
      data,
    })
  ).rejects.toMatchObject({code: 'failed-precondition'});
  mocks.get.mockImplementation(async (path: string) =>
    path.endsWith('/transcripts')
      ? {
          docs: transcript.map(t => ({
            id: t.id,
            data: () => ({...t, text: 'x'.repeat(300001)}),
          })),
        }
      : {exists: true, data: () => stored}
  );
  await expect(
    (generateCallReview as unknown as Handler<ReviewAttempt>)({
      auth: admin,
      data,
    })
  ).rejects.toMatchObject({code: 'resource-exhausted'});
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each([
  {ok: false},
  {ok: true, json: async () => ({status: 'incomplete', output: []})},
  {
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [{content: [{type: 'refusal'}]}],
    }),
  },
  {
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [{content: [{type: 'output_text', text: '{"categories":[]}'}]}],
    }),
  },
])(
  'records retryable failure for rejected, incomplete or invalid provider output',
  async response => {
    mocks.fetch.mockResolvedValueOnce(response);
    await expect(
      (generateCallReview as unknown as Handler<ReviewAttempt>)({
        auth: admin,
        data,
      })
    ).rejects.toMatchObject({code: 'unavailable'});
    expect(mocks.set).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({status: 'failed'})
    );
  }
);

it('reuses a matching saved review without another provider call', async () => {
  const result = {
    summary: 'Good',
    strengths: [],
    limitations: [],
    categories: CATEGORY_NAMES.map(name => ({
      name,
      score: 4,
      explanation: 'Helpful',
      evidenceIds: ['assistant'],
    })),
    suggestions: [],
  };
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        {content: [{type: 'output_text', text: JSON.stringify(result)}]},
      ],
    }),
  });
  mocks.transactionGet.mockImplementation(async () => ({
    data: () => ({
      ...stored,
      reviewAttemptId: mocks.update.mock.calls[0]?.[1]?.reviewAttemptId,
    }),
  }));
  const saved = await (generateCallReview as unknown as Handler<ReviewAttempt>)(
    {auth: admin, data}
  );
  mocks.transactionGet.mockImplementation(async ref => ({
    data: () =>
      ref.path.includes('/reviews/')
        ? saved
        : {...stored, latestReviewId: saved.id},
  }));
  const cached = await (
    generateCallReview as unknown as Handler<ReviewAttempt>
  )({auth: admin, data});
  expect(cached.id).toBe(saved.id);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});

it('plays recordings from the default local development bucket in emulator mode', async () => {
  vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
  vi.stubEnv('FIREBASE_STORAGE_EMULATOR_HOST', '127.0.0.1:9199');
  mocks.get.mockResolvedValue({
    exists: true,
    data: () => ({
      ...stored,
      recording: {
        ...(stored.recording as object),
        bucket: 'demo-test.firebasestorage.app',
      },
    }),
  });
  mocks.metadata.mockResolvedValue([{size: '728984'}]);
  mocks.download.mockResolvedValue([Buffer.from('local recording')]);
  await expect(
    (getReviewAudio as unknown as Handler)({auth: admin, data})
  ).resolves.toMatchObject({
    url: `data:audio/wav;base64,${Buffer.from('local recording').toString('base64')}`,
  });
  expect(mocks.signed).not.toHaveBeenCalled();
});
it('does not allow the default local bucket in production', async () => {
  mocks.get.mockResolvedValue({
    exists: true,
    data: () => ({
      ...stored,
      recording: {
        ...(stored.recording as object),
        bucket: 'demo-test.firebasestorage.app',
      },
    }),
  });
  await expect(
    (getReviewAudio as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'failed-precondition'});
  expect(mocks.download).not.toHaveBeenCalled();
});
it('rejects unrelated buckets even in emulator mode', async () => {
  vi.stubEnv('FUNCTIONS_EMULATOR', 'true');
  vi.stubEnv('FIREBASE_STORAGE_EMULATOR_HOST', '127.0.0.1:9199');
  mocks.get.mockResolvedValue({
    exists: true,
    data: () => ({
      ...stored,
      recording: {
        ...(stored.recording as object),
        bucket: 'other-project.firebasestorage.app',
      },
    }),
  });
  await expect(
    (getReviewAudio as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'failed-precondition'});
  expect(mocks.download).not.toHaveBeenCalled();
});

it('deletes all call storage objects before recursively deleting Firestore', async () => {
  await expect(
    (deleteCall as unknown as Handler)({auth: admin, data})
  ).resolves.toEqual({...data, deleted: true});
  expect(mocks.update).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({status: 'deleting'})
  );
  expect(mocks.deleteFiles).toHaveBeenCalledWith({
    prefix: 'sessions/visitor/calls/call/',
    force: true,
  });
  expect(mocks.recursiveDelete).toHaveBeenCalledWith(
    expect.objectContaining({path: 'sessions/visitor/calls/call'})
  );
  expect(mocks.deleteFiles.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.recursiveDelete.mock.invocationCallOrder[0]
  );
});
it.each(['active', 'paused', 'saving'])(
  'does not delete a %s call',
  async status => {
    mocks.transactionGet.mockResolvedValue({data: () => ({...stored, status})});
    await expect(
      (deleteCall as unknown as Handler)({auth: admin, data})
    ).rejects.toMatchObject({code: 'failed-precondition'});
    expect(mocks.deleteFiles).not.toHaveBeenCalled();
  }
);
it('blocks deletion while a review or another deletion is running', async () => {
  mocks.transactionGet.mockResolvedValueOnce({
    data: () => ({...stored, reviewLeaseUntil: Date.now() + 60000}),
  });
  await expect(
    (deleteCall as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'failed-precondition'});
  mocks.transactionGet.mockResolvedValueOnce({
    data: () => ({
      ...stored,
      status: 'deleting',
      deletionLeaseUntil: Date.now() + 60000,
    }),
  });
  await expect(
    (deleteCall as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'already-exists'});
  expect(mocks.deleteFiles).not.toHaveBeenCalled();
});
it('allows retry of failed saves, missing calls and expired deletion leases', async () => {
  for (const current of [
    {...stored, recordingStatus: 'failed'},
    undefined,
    {...stored, status: 'deleting', deletionLeaseUntil: 0},
  ]) {
    mocks.transactionGet.mockResolvedValue({data: () => current});
    await expect(
      (deleteCall as unknown as Handler)({auth: admin, data})
    ).resolves.toMatchObject({deleted: true});
  }
  expect(mocks.recursiveDelete).toHaveBeenCalledTimes(3);
});
it('retains a retryable call when storage deletion fails', async () => {
  mocks.deleteFiles.mockRejectedValueOnce(new Error('private failure details'));
  await expect(
    (deleteCall as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({
    code: 'unavailable',
    message: 'Call deletion could not finish. Retry to complete cleanup.',
  });
  expect(mocks.recursiveDelete).not.toHaveBeenCalled();
  expect(mocks.update).toHaveBeenLastCalledWith(expect.anything(), {
    deletionLeaseUntil: 0,
  });
});
it('does not recreate a parent deleted by a partial Firestore cleanup', async () => {
  mocks.recursiveDelete.mockRejectedValueOnce(new Error('partial deletion'));
  mocks.transactionGet
    .mockResolvedValueOnce({data: () => stored})
    .mockResolvedValueOnce({data: () => undefined});
  await expect(
    (deleteCall as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'unavailable'});
  expect(mocks.update).toHaveBeenCalledTimes(1);
});
it('rejects recording references outside the call before deleting anything', async () => {
  for (const recording of [
    {
      bucket: 'other-bucket',
      objectPath: 'sessions/visitor/calls/call/recording.wav',
    },
    {
      bucket: 'demo-test-call-recordings',
      objectPath: 'sessions/visitor/calls/call-other/recording.wav',
    },
  ]) {
    mocks.transactionGet.mockResolvedValueOnce({
      data: () => ({...stored, recording}),
    });
    await expect(
      (deleteCall as unknown as Handler)({auth: admin, data})
    ).rejects.toMatchObject({code: 'failed-precondition'});
  }
  expect(mocks.deleteFiles).not.toHaveBeenCalled();
});
it('does not recreate review descendants if deletion wins the review completion race', async () => {
  mocks.fetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                summary: 'Good',
                strengths: [],
                limitations: [],
                categories: CATEGORY_NAMES.map(name => ({
                  name,
                  score: 4,
                  explanation: 'Helpful',
                  evidenceIds: ['assistant'],
                })),
                suggestions: [],
              }),
            },
          ],
        },
      ],
    }),
  });
  mocks.transactionGet
    .mockResolvedValueOnce({data: () => stored})
    .mockResolvedValue({data: () => undefined});
  await expect(
    (generateCallReview as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'unavailable'});
  expect(mocks.set).toHaveBeenCalledTimes(1); // Initial attempt only, no late result/failure write.
});
it('rejects review generation when deletion won the transaction race', async () => {
  mocks.transactionGet.mockResolvedValueOnce({
    data: () => ({...stored, status: 'deleting'}),
  });
  await expect(
    (generateCallReview as unknown as Handler)({auth: admin, data})
  ).rejects.toMatchObject({code: 'failed-precondition'});
  expect(mocks.fetch).not.toHaveBeenCalled();
});
