import { useEffect, useRef, useState } from 'react';
import type {
  TranscriptUpdate,
  CallStatus,
} from '@living-community-assistant/types';
import { startSocket, type ConnectionStatus } from './api/socket';
import { VoiceSession, type VoiceStatus } from './audio/voice';
import { microphoneSupported } from './audio/capture';
import styles from './app.module.scss';
import { AccessGate } from './access-gate';
import { lockApp } from './api/session';
import { Routes, Route } from 'react-router-dom';
import { AdminPage } from './admin-page';

function MicrophoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
    </svg>
  );
}

export function App() {
  return (
    <Routes>
      <Route
        path="/admin"
        element={
          <AccessGate key="admin" admin>
            <AdminPage />
          </AccessGate>
        }
      />
      <Route
        path="*"
        element={
          <AccessGate key="app">
            <Workspace />
          </AccessGate>
        }
      />
    </Routes>
  );
}

export function Workspace() {
  const [socketStatus, setSocketStatus] = useState<ConnectionStatus>({
    state: 'connecting',
  });
  const [call, setCall] = useState<CallStatus>();
  const [callError, setCallError] = useState<string>();
  const callId = useRef<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const voice = useRef<VoiceSession | undefined>(undefined);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    state: 'idle',
  });
  const [microphoneName, setMicrophoneName] = useState('Default microphone');
  const [playbackIssue, setPlaybackIssue] = useState<string>();
  const [transcripts, setTranscripts] = useState<TranscriptUpdate[]>([]);

  useEffect(() => {
    let disposed = false;
    setTranscripts([]);
    const connection = startSocket(
      (status) => {
        if (disposed) return;
        setSocketStatus(status);
        if (status.state !== 'connected') voice.current?.disconnect();
        if (status.state === 'disconnected') {
          setCall(undefined);
          callId.current = undefined;
        }
      },
      (status) => {
        if (disposed) return;
        if (status.state === 'active' && callId.current !== status.callId) {
          callId.current = status.callId;
          setTranscripts([]);
        }
        if (callId.current === status.callId) {
          setCall(status);
          if (['saving', 'saved', 'failed'].includes(status.state))
            voice.current?.finishClosing();
        }
      },
    );
    const unsubscribe = connection.onTranscript((update) => {
      if (disposed) return;
      setTranscripts((entries) => {
        const index = entries.findIndex((entry) => entry.id === update.id);
        if (index === -1)
          return [...entries, update].sort(
            (a, b) => (a.order ?? 0) - (b.order ?? 0),
          );
        if (
          update.revision !== undefined &&
          (entries[index].revision ?? 0) >= update.revision
        )
          return entries;
        if (entries[index].isFinal && update.revision === undefined)
          return entries;
        return entries.map((entry, i) => (i === index ? update : entry));
      });
    });
    const session = new VoiceSession(
      connection,
      (status) => {
        if (disposed) return;
        setVoiceStatus(status);
        if (status.microphoneName) setMicrophoneName(status.microphoneName);
      },
      (issue) => {
        if (!disposed) setPlaybackIssue(issue);
      },
    );
    voice.current = session;
    return () => {
      disposed = true;
      unsubscribe();
      session.dispose();
      voice.current = undefined;
      connection();
    };
  }, [attempt]);

  const active = [
    'requesting permission',
    'connecting voice',
    'streaming',
  ].includes(voiceStatus.state);
  const pending = [
    'requesting permission',
    'connecting voice',
    'stopping',
  ].includes(voiceStatus.state);
  const buttonLabel =
    voiceStatus.state === 'closing'
      ? 'Ending call…'
      : voiceStatus.state === 'stopping'
        ? 'Stopping…'
        : active
          ? 'Pause'
          : call?.state === 'paused'
            ? 'Resume'
            : 'Start session';

  return (
    <main className={styles['page']}>
      <header className={styles['header']}>
        <h1>Living Community Assistant</h1>
        <div className={styles['connection']}>
          <button
            className={styles['textButton']}
            onClick={() => {
              void lockApp().catch(() =>
                setCallError('Could not sign out. Please retry.'),
              );
            }}
          >
            Sign out
          </button>
          <span role="status" aria-label="Socket connection status">
            <span
              aria-hidden="true"
              className={`${styles['dot']} ${styles[socketStatus.state]}`}
            />
            {socketStatus.state === 'connected'
              ? 'Socket on'
              : socketStatus.state === 'connecting'
                ? 'Connecting…'
                : 'Socket off'}
          </span>
          {socketStatus.state === 'disconnected' && (
            <button
              className={styles['textButton']}
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry connection
            </button>
          )}
        </div>
      </header>
      <div className={styles['workspace']}>
        <section className={styles['session']} aria-label="Session controls">
          <div className={styles['controls']}>
            <button
              className={styles['primary']}
              disabled={
                voiceStatus.state === 'stopping' ||
                voiceStatus.state === 'closing' ||
                call?.state === 'closing' ||
                call?.state === 'saving' ||
                call?.state === 'failed' ||
                (!active &&
                  (!microphoneSupported() ||
                    socketStatus.state !== 'connected'))
              }
              onClick={() =>
                void (active ? voice.current?.stop() : voice.current?.start())
              }
            >
              <span className={styles['buttonIcon']} aria-hidden="true">
                {active ? '■' : '▶'}
              </span>
              {buttonLabel}
            </button>
            {call && ['active', 'paused'].includes(call.state) && (
              <button
                className={styles['textButton']}
                disabled={pending}
                onClick={() => {
                  setCallError(undefined);
                  void voice.current
                    ?.end()
                    .catch(() =>
                      setCallError('Could not end call. Please retry.'),
                    );
                }}
              >
                End call
              </button>
            )}
            <span className={styles['microphone']} title={microphoneName}>
              <MicrophoneIcon />
              <span>{microphoneName}</span>
            </span>
          </div>
          <p
            className={styles['sessionStatus']}
            role="status"
            aria-label="Microphone status"
          >
            {voiceStatus.state === 'closing'
              ? 'Finishing the simulated sales transfer…'
              : pending
                ? voiceStatus.state === 'requesting permission'
                  ? 'Waiting for microphone permission…'
                  : voiceStatus.state === 'connecting voice'
                    ? 'Starting session…'
                    : 'Ending session…'
                : voiceStatus.state === 'streaming'
                  ? 'Listening · Speak to the assistant'
                  : 'Start a session to talk with the assistant.'}
          </p>
          {!microphoneSupported() && (
            <p role="alert">
              Microphone streaming requires Web Audio and microphone access on
              HTTPS or localhost.
            </p>
          )}
          {call && (
            <p role="status" aria-label="Call status">
              {call.state === 'closing'
                ? 'Demo sales transfer · Ending call…'
                : call.state === 'saved' &&
                    call.endReason === 'demo_sales_handoff'
                  ? 'Demo transfer complete. Call ended and saved.'
                  : call.state === 'saving'
                    ? 'Saving call…'
                    : call.state === 'saved'
                      ? 'Call saved'
                      : call.state === 'failed'
                        ? 'Save failed'
                        : call.state === 'paused'
                          ? 'Call paused'
                          : 'Call active'}
            </p>
          )}
          {call?.message && <p role="alert">{call.message}</p>}
          {call?.state === 'failed' && (
            <button
              onClick={() => {
                void voice.current
                  ?.retrySave()
                  .catch(() => setCallError('Could not retry save.'));
              }}
            >
              Retry save
            </button>
          )}
          {callError && <p role="alert">{callError}</p>}
          {socketStatus.error && <p role="alert">{socketStatus.error}</p>}
          {voiceStatus.warning && <p role="alert">{voiceStatus.warning}</p>}
          {voiceStatus.error && <p role="alert">{voiceStatus.error}</p>}
          {playbackIssue && (
            <div role="alert">
              {playbackIssue}{' '}
              <button
                className={styles['textButton']}
                onClick={() => void voice.current?.enableAudio()}
              >
                Enable audio
              </button>
            </div>
          )}
        </section>
        <section
          className={styles['transcript']}
          aria-labelledby="transcript-title"
        >
          <div className={styles['transcriptHeading']}>
            <h2 id="transcript-title">Transcript</h2>
            {transcripts.length > 0 && <span>Newest first</span>}
          </div>
          {transcripts.length === 0 ? (
            <div className={styles['empty']}>
              <div className={styles['wave']} aria-hidden="true">
                {[12, 24, 36, 20, 30, 16, 10].map((height, i) => (
                  <span key={i} style={{ height }} />
                ))}
              </div>
              <p>Your conversation will appear here</p>
              <span>Transcripts appear as they become available.</span>
            </div>
          ) : (
            <div
              className={styles['entries']}
              role="region"
              tabIndex={0}
              aria-label="Conversation transcript"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {[...transcripts].reverse().map((entry) => (
                <article
                  key={entry.id}
                  className={`${styles['entry']} ${styles[entry.role]} ${!entry.isFinal ? styles['partial'] : ''}`}
                >
                  <div className={styles['messageHeading']}>
                    <h3>{entry.role === 'user' ? 'You' : 'Assistant'}</h3>
                    {entry.createdAt &&
                      Number.isFinite(Date.parse(entry.createdAt)) && (
                        <time
                          dateTime={entry.createdAt}
                          title={new Date(entry.createdAt).toLocaleString()}
                        >
                          {new Date(entry.createdAt).toLocaleTimeString([], {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </time>
                      )}
                  </div>
                  <p>
                    {entry.text}
                    {entry.interrupted && <span> (interrupted)</span>}
                    {entry.incomplete && <span> (incomplete)</span>}
                    {!entry.isFinal && (
                      <span
                        className={styles['cursor']}
                        aria-label="Transcribing"
                      >
                        ▍
                      </span>
                    )}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export default App;
