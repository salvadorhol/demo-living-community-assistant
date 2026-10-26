import {useEffect, useRef, useState} from 'react';
import {Link, useLocation, useNavigate, useParams} from 'react-router-dom';
import type {
  ReviewCallDetail,
  ReviewCallPage,
  ReviewCallSummary,
} from '@living-community-assistant/types';
import {
  listReviewCalls,
  getReviewCall,
  getReviewAudio,
  generateCallReview,
  deleteCall,
} from './api/review';
import styles from './review-page.module.scss';
const message = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^.*?: /, '')
    : 'Something went wrong. Please retry.';
const date = (value: string) =>
  value ? new Date(value).toLocaleString() : 'Unknown date';
function CallLabel({call}: {call: ReviewCallSummary}) {
  return (
    <>
      <strong>{date(call.startedAt)}</strong>
      <span>
        {call.durationMs === null
          ? 'Duration unavailable'
          : `${Math.round(call.durationMs / 1000)} seconds`}{' '}
        · {call.status} · Recording {call.recordingStatus}
      </span>
      <span>
        {call.latestReviewScore === null
          ? 'Not scored'
          : `${call.latestReviewScore}/5`}
      </span>
    </>
  );
}
export function ReviewPage() {
  const {uid, callId} = useParams();
  return (
    <section aria-label="Review" className={styles['review']}>
      <h2>Review</h2>
      <p>
        Listen to calls, read transcripts, and review Sophie’s interactions.
      </p>
      {uid && callId ? (
        <CallDetail key={`${uid}/${callId}`} uid={uid} callId={callId} />
      ) : (
        <CallList />
      )}
    </section>
  );
}
function DeleteCallButton({
  call,
  disabled,
  onBusy,
  onDeleted,
}: {
  call: ReviewCallSummary;
  disabled?: boolean;
  onBusy(busy: boolean): void;
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <div className={styles['deleteAction']}>
      <button
        className={styles['deleteButton']}
        disabled={
          disabled || busy || !['ended', 'deleting'].includes(call.status)
        }
        aria-label={`${call.status === 'deleting' ? 'Retry deleting' : 'Delete'} call ${date(call.startedAt)} (${call.callId})`}
        onClick={() => {
          if (
            inFlight.current ||
            !window.confirm(
              `Permanently delete the call from ${date(call.startedAt)}? This removes its audio, transcript, and AI reviews and cannot be undone.`
            )
          )
            return;
          inFlight.current = true;
          setBusy(true);
          setError('');
          onBusy(true);
          void deleteCall({uid: call.uid, callId: call.callId})
            .then(() => {
              if (mounted.current) onDeleted();
            })
            .catch(e => {
              if (mounted.current) setError(message(e));
            })
            .finally(() => {
              inFlight.current = false;
              if (mounted.current) {
                setBusy(false);
                onBusy(false);
              }
            });
        }}
      >
        {busy
          ? 'Deleting…'
          : call.status === 'deleting'
            ? 'Retry deletion'
            : 'Delete call'}
      </button>
      {busy && (
        <span role="status">Deleting audio, transcript, and reviews…</span>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function CallList() {
  const location = useLocation();
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState(
    location.state?.callDeleted ? 'Call deleted.' : ''
  );
  const [calls, setCalls] = useState<ReviewCallSummary[]>([]);
  const [cursor, setCursor] = useState<ReviewCallPage['nextCursor']>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    void listReviewCalls()
      .then(page => {
        if (!disposed) {
          setCalls(page.calls);
          setCursor(page.nextCursor);
        }
      })
      .catch(e => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [revision]);
  return (
    <>
      <button
        disabled={loading || deleting}
        onClick={() => setRevision(v => v + 1)}
      >
        Refresh calls
      </button>
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading calls…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !calls.length && !cursor && (
        <p>No audio sessions yet.</p>
      )}
      <ul className={styles['calls']}>
        {calls.map(call => (
          <li key={`${call.uid}/${call.callId}`}>
            <Link
              to={`/admin/review/${encodeURIComponent(call.uid)}/${encodeURIComponent(call.callId)}`}
            >
              <CallLabel call={call} />
            </Link>
            <DeleteCallButton
              call={call}
              disabled={loading || deleting}
              onBusy={setDeleting}
              onDeleted={() => {
                setDeleting(false);
                setCalls(old =>
                  old.filter(
                    item => item.uid !== call.uid || item.callId !== call.callId
                  )
                );
                setNotice('Call deleted.');
              }}
            />
          </li>
        ))}
      </ul>
      {cursor && (
        <button
          disabled={loading || deleting}
          onClick={() => {
            setLoading(true);
            setError('');
            void listReviewCalls(cursor)
              .then(page => {
                setCalls(old => [
                  ...new Map(
                    [...old, ...page.calls].map(call => [
                      `${call.uid}/${call.callId}`,
                      call,
                    ])
                  ).values(),
                ]);
                setCursor(page.nextCursor);
              })
              .catch(e => setError(message(e)))
              .finally(() => setLoading(false));
          }}
        >
          Load more calls
        </button>
      )}
    </>
  );
}
function CallDetail({uid, callId}: {uid: string; callId: string}) {
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [call, setCall] = useState<ReviewCallDetail>();
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [audio, setAudio] = useState<{url: string; expiresAt: number}>();
  const [audioError, setAudioError] = useState('');
  const [audioBusy, setAudioBusy] = useState(false);
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const player = useRef<HTMLAudioElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    void getReviewCall({uid, callId})
      .then(value => {
        if (!disposed) {
          setCall(value);
          setError('');
        }
      })
      .catch(e => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
    };
  }, [uid, callId, revision]);
  const running =
    busy ||
    !!(
      call?.attempt?.status === 'running' &&
      call.attempt.leaseUntil > Date.now()
    );
  useEffect(() => {
    if (!running || deleting) return;
    const timer = setInterval(() => setRevision(v => v + 1), 3000);
    return () => clearInterval(timer);
  }, [running, deleting]);
  function loadAudio() {
    setAudioBusy(true);
    setAudioError('');
    void getReviewAudio({uid, callId})
      .then(value => {
        if (mounted.current) setAudio(value);
      })
      .catch(e => {
        if (mounted.current) setAudioError(message(e));
      })
      .finally(() => {
        if (mounted.current) setAudioBusy(false);
      });
  }
  const result = call?.latestReview?.result;
  function evidence(ids: string[]) {
    return ids.length ? (
      <button
        className={styles['evidence']}
        onClick={() => {
          setSelectedEvidence(ids);
          document
            .getElementById(`utterance-${ids[0]}`)
            ?.scrollIntoView({block: 'center', behavior: 'smooth'});
        }}
      >
        Show transcript evidence
      </button>
    ) : null;
  }
  return (
    <>
      <Link to="/admin/review">← All calls</Link>
      {error && <p role="alert">{error}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      <button disabled={deleting} onClick={() => setRevision(v => v + 1)}>
        Refresh call
      </button>
      {!call ? (
        <p role="status">Loading call…</p>
      ) : (
        <>
          <div className={styles['metadata']}>
            <CallLabel call={call} />
            <small>Call {call.callId}</small>
          </div>
          <DeleteCallButton
            call={call}
            disabled={running || deleting}
            onBusy={value => {
              setDeleting(value);
              if (value) player.current?.pause();
            }}
            onDeleted={() =>
              navigate('/admin/review', {
                replace: true,
                state: {callDeleted: true},
              })
            }
          />

          <section aria-label="Call audio">
            <h3>Audio</h3>
            {call.recordingStatus === 'saved' ? (
              <>
                <button disabled={audioBusy || deleting} onClick={loadAudio}>
                  {audioBusy
                    ? 'Loading audio…'
                    : audio
                      ? 'Refresh audio access'
                      : 'Load audio'}
                </button>
                {audio && (
                  <>
                    <audio
                      ref={player}
                      controls
                      preload="metadata"
                      src={audio.url}
                      onError={() =>
                        setAudioError(
                          'Audio could not be played. Refresh audio access and retry.'
                        )
                      }
                    >
                      <track kind="captions" />
                      Your browser does not support audio playback.
                    </audio>
                    <label>
                      Playback speed{' '}
                      <select
                        defaultValue="1"
                        onChange={e => {
                          if (player.current)
                            player.current.playbackRate = Number(
                              e.target.value
                            );
                        }}
                      >
                        {[0.75, 1, 1.25, 1.5, 2].map(speed => (
                          <option key={speed} value={speed}>
                            {speed}×
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            ) : (
              <p>Recording {call.recordingStatus}. Audio is unavailable.</p>
            )}
            {audioError && <p role="alert">{audioError}</p>}
          </section>
          <section aria-label="AI review">
            <h3>AI review</h3>
            <p>
              Transcription-only assessment for senior-living sales. Suggestions
              are advisory; audio and actual tool execution are not evaluated.
            </p>
            <button
              disabled={
                running ||
                deleting ||
                call.status !== 'ended' ||
                !call.transcripts.length
              }
              onClick={() => {
                setBusy(true);
                setActionError('');
                void generateCallReview({uid, callId}, !!result)
                  .then(() => {
                    if (mounted.current) setRevision(v => v + 1);
                  })
                  .catch(e => {
                    if (mounted.current) {
                      setActionError(message(e));
                      setRevision(v => v + 1);
                    }
                  })
                  .finally(() => {
                    if (mounted.current) setBusy(false);
                  });
              }}
            >
              {running
                ? 'Review in progress…'
                : result
                  ? 'Regenerate review'
                  : 'Generate review'}
            </button>
            {call.status !== 'ended' && (
              <p>Review is available after the call ends.</p>
            )}
            {running && (
              <p role="status">
                Review is running. You can leave this page and return later.
              </p>
            )}
            {call.attempt?.status === 'failed' && (
              <p role="alert">{call.attempt.error}</p>
            )}
            {call.attempt?.status === 'running' && !running && (
              <p>
                The previous review timed out. Generate a new review to retry.
              </p>
            )}
            {result && (
              <>
                <h4>
                  {result.overallScore === null
                    ? 'Insufficient evidence'
                    : `Overall score: ${result.overallScore}/5`}
                </h4>
                <p>{result.summary}</p>
                <small>
                  {call.latestReview?.model} ·{' '}
                  {call.latestReview?.rubricVersion} ·{' '}
                  {date(call.latestReview?.finishedAt ?? '')}
                </small>
                <h4>Scorecard</h4>
                <ul>
                  {result.categories.map(c => (
                    <li key={c.name}>
                      <strong>
                        {c.name}:{' '}
                        {c.score === null ? 'Unassessable' : `${c.score}/5`}
                      </strong>
                      <p>{c.explanation}</p>
                      {evidence(c.evidenceIds)}
                    </li>
                  ))}
                </ul>
                <h4>Strengths</h4>
                <ul>
                  {result.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
                <h4>Suggested improvements</h4>
                {!result.suggestions.length && (
                  <p>No specific improvements identified.</p>
                )}
                {result.suggestions.map((s, i) => (
                  <article key={i}>
                    <h4>
                      {s.priority} priority · {s.target}
                    </h4>
                    <p>{s.observation}</p>
                    <p>{s.recommendation}</p>
                    {s.suggestedWording && (
                      <blockquote>{s.suggestedWording}</blockquote>
                    )}
                    {evidence(s.evidenceIds)}
                  </article>
                ))}
                <h4>Evidence limitations</h4>
                <ul>
                  {result.limitations.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </>
            )}
          </section>
          <section aria-label="Call transcript">
            <h3>Transcript</h3>
            {call.transcriptionStatus === 'degraded' && (
              <p>Transcription was degraded. Some speech may be missing.</p>
            )}
            {!call.transcripts.length && <p>No transcript is available.</p>}
            <ol className={styles['transcripts']}>
              {call.transcripts.map(t => (
                <li
                  id={`utterance-${t.id}`}
                  key={t.id}
                  className={
                    selectedEvidence.includes(t.id)
                      ? styles['highlight']
                      : undefined
                  }
                >
                  <strong>{t.role === 'user' ? 'Visitor' : 'Sophie'}</strong>
                  {t.interrupted && <small> · Interrupted</small>}
                  {(t.incomplete || !t.isFinal) && <small> · Incomplete</small>}
                  <p>{t.text}</p>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}
