import {fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router-dom';
import {ReviewPage} from './review-page';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  detail: vi.fn(),
  audio: vi.fn(),
  generate: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('./api/review', () => ({
  listReviewCalls: mocks.list,
  getReviewCall: mocks.detail,
  getReviewAudio: mocks.audio,
  generateCallReview: mocks.generate,
  deleteCall: mocks.delete,
}));
const call = {
  uid: 'visitor',
  callId: 'one',
  startedAt: '2026-10-25T12:00:00Z',
  endedAt: '2026-10-25T12:01:00Z',
  status: 'ended',
  recordingStatus: 'saved',
  durationMs: 60000,
  transcriptionStatus: 'degraded',
  latestReviewScore: null,
  transcripts: [
    {id: 'u1', role: 'user', text: 'I would like a tour.', isFinal: true},
    {
      id: 'a1',
      role: 'assistant',
      text: 'I can help you.',
      isFinal: true,
      interrupted: true,
    },
  ],
  attempt: null,
  latestReview: null,
};
function open(path = '/admin/review') {
  render(
    <RouterProvider
      router={createMemoryRouter(
        [
          {path: '/admin/review', element: <ReviewPage />},
          {path: '/admin/review/:uid/:callId', element: <ReviewPage />},
        ],
        {initialEntries: [path]}
      )}
    />
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({calls: [call], nextCursor: null});
  mocks.detail.mockResolvedValue(call);
  mocks.audio.mockResolvedValue({
    url: 'https://example.test/audio',
    expiresAt: Date.now() + 60000,
  });
  mocks.generate.mockResolvedValue({});
  mocks.delete.mockResolvedValue({
    uid: 'visitor',
    callId: 'one',
    deleted: true,
  });
});
it('opens a listed call and displays transcript and audio controls', async () => {
  open();
  fireEvent.click(await screen.findByRole('link', {name: /60 seconds/}));
  await screen.findByText('I would like a tour.');
  expect(screen.getByText(/Transcription was degraded/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: 'Load audio'}));
  await screen.findByLabelText('Playback speed');
  expect(document.querySelector('audio')?.getAttribute('src')).toBe(
    'https://example.test/audio'
  );
});
it('paginates and retries failed list loads', async () => {
  mocks.list.mockRejectedValueOnce(new Error('Try again'));
  open();
  await screen.findByRole('alert');
  mocks.list.mockResolvedValueOnce({
    calls: [call],
    nextCursor: {path: 'sessions/visitor/calls/one', startedAt: call.startedAt},
  });
  fireEvent.click(screen.getByRole('button', {name: 'Refresh calls'}));
  fireEvent.click(await screen.findByRole('button', {name: 'Load more calls'}));
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(3));
});
it('generates a review and preserves advice on regeneration failure', async () => {
  open('/admin/review/visitor/one');
  const generate = await screen.findByRole('button', {name: 'Generate review'});
  const latestReview = {
    model: 'gpt-6-luna',
    rubricVersion: 'senior-living-v1',
    result: {
      overallScore: 4,
      summary: 'Warm response',
      categories: [],
      strengths: ['Helpful'],
      suggestions: [],
      limitations: ['Transcript only'],
    },
  };
  mocks.detail.mockResolvedValue({...call, latestReview});
  fireEvent.click(generate);
  await screen.findByText('Overall score: 4/5');
  expect(mocks.generate).toHaveBeenCalledWith(
    {uid: 'visitor', callId: 'one'},
    false
  );
  mocks.generate.mockRejectedValueOnce(new Error('Review unavailable'));
  fireEvent.click(screen.getByRole('button', {name: 'Regenerate review'}));
  await screen.findByText('Review unavailable');
  expect(screen.getByText('Warm response')).toBeTruthy();
});
it('disables reviews during active calls and handles missing audio', async () => {
  mocks.detail.mockResolvedValue({
    ...call,
    status: 'active',
    recordingStatus: 'pending',
  });
  open('/admin/review/visitor/one');
  const button = await screen.findByRole('button', {name: 'Generate review'});
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('button', {name: 'Load audio'})).toBeNull();
  expect(
    (screen.getByRole('button', {name: /^Delete call /}) as HTMLButtonElement)
      .disabled
  ).toBe(true);
});

it('confirms deletion and removes a call from the list without navigating', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    open();
    fireEvent.click(await screen.findByRole('button', {name: /^Delete call /}));
    await screen.findByText('Call deleted.');
    expect(mocks.delete).toHaveBeenCalledWith({uid: 'visitor', callId: 'one'});
    expect(screen.queryByRole('link', {name: /60 seconds/})).toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('cannot be undone')
    );
  } finally {
    confirm.mockRestore();
  }
});
it('does not delete when confirmation is cancelled', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  try {
    open();
    fireEvent.click(await screen.findByRole('button', {name: /^Delete call /}));
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('link', {name: /60 seconds/})).toBeTruthy();
  } finally {
    confirm.mockRestore();
  }
});
it('keeps the call and displays a deletion failure for retry', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocks.delete.mockRejectedValueOnce(
    new Error('Cleanup failed. Retry to complete cleanup.')
  );
  try {
    open();
    fireEvent.click(await screen.findByRole('button', {name: /^Delete call /}));
    await screen.findByRole('alert');
    expect(screen.getByRole('link', {name: /60 seconds/})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: /^Delete call /}));
    await screen.findByText('Call deleted.');
    expect(mocks.delete).toHaveBeenCalledTimes(2);
  } finally {
    confirm.mockRestore();
  }
});
it('returns to the call list after deleting from call details', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  try {
    mocks.list.mockResolvedValue({calls: [], nextCursor: null});
    open('/admin/review/visitor/one');
    fireEvent.click(await screen.findByRole('button', {name: /^Delete call /}));
    await screen.findByText('Call deleted.');
    await screen.findByText('No audio sessions yet.');
    expect(screen.queryByRole('region', {name: 'Call transcript'})).toBeNull();
  } finally {
    confirm.mockRestore();
  }
});
it('disables deletion of active calls and during an active review', async () => {
  mocks.detail.mockResolvedValue({
    ...call,
    attempt: {status: 'running', leaseUntil: Date.now() + 60000},
  });
  open('/admin/review/visitor/one');
  expect(
    (
      (await screen.findByRole('button', {
        name: /^Delete call /,
      })) as HTMLButtonElement
    ).disabled
  ).toBe(true);
});

it('prevents duplicate deletion requests and leaves other calls usable after success', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  let finish: (() => void) | undefined;
  mocks.delete.mockReturnValueOnce(
    new Promise<void>(resolve => {
      finish = resolve;
    })
  );
  mocks.list.mockResolvedValue({
    calls: [call, {...call, callId: 'two'}],
    nextCursor: null,
  });
  try {
    open();
    const first = await screen.findByRole('button', {
      name: /Delete call .*\(one\)/,
    });
    fireEvent.click(first);
    fireEvent.click(first);
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(
      (
        screen.getByRole('button', {
          name: /Delete call .*\(two\)/,
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true);
    finish?.();
    await screen.findByText('Call deleted.');
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: /Delete call .*\(two\)/,
          }) as HTMLButtonElement
        ).disabled
      ).toBe(false)
    );
  } finally {
    confirm.mockRestore();
  }
});
