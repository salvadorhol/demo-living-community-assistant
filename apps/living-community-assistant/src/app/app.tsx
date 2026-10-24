import { useEffect, useRef, useState } from 'react';
import { checkHealth } from './api/health';
import { startSocket, type ConnectionStatus } from './api/socket';
import { VoiceSession, type VoiceStatus } from './audio/voice';
import { microphoneSupported } from './audio/capture';
import styles from './app.module.scss';

export function App() {
  const [socketStatus, setSocketStatus] = useState<ConnectionStatus>({
    state: 'connecting',
  });
  const [attempt, setAttempt] = useState(0);
  const voice = useRef<VoiceSession | undefined>(undefined);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>({
    state: 'idle',
  });
  const [playbackIssue, setPlaybackIssue] = useState<string>();
  useEffect(() => {
    const connection = startSocket((status) => {
      setSocketStatus(status);
      if (status.state !== 'connected') voice.current?.disconnect();
    });
    const session = new VoiceSession(
      connection,
      setVoiceStatus,
      setPlaybackIssue,
    );
    voice.current = session;
    return () => {
      session.dispose();
      voice.current = undefined;
      connection();
    };
  }, [attempt]);
  const [status, setStatus] = useState('Ready to check backend connectivity.');
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    setStatus('Checking backend…');
    try {
      const result = await checkHealth();
      setStatus(
        `Backend ${result.status} · ${new Date(result.time).toLocaleTimeString()}`,
      );
    } catch {
      setStatus(
        'Backend unavailable. Check that your backend is running and configured.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className={styles['page']}>
      <p className={styles['eyebrow']}>Development workspace</p>
      <h1>Living Community Assistant</h1>
      <p>Your workspace is ready for development.</p>
      <section aria-labelledby="socket-title">
        <h2 id="socket-title">Socket connection</h2>
        <p role="status" aria-label="Socket connection status">
          <span
            aria-hidden="true"
            className={`${styles['dot']} ${styles[socketStatus.state]}`}
          />
          Socket {socketStatus.state}
        </p>
        {socketStatus.error && <p>{socketStatus.error}</p>}
        {socketStatus.state === 'disconnected' && (
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry connection
          </button>
        )}
      </section>
      <section aria-labelledby="microphone-title">
        <h2 id="microphone-title">Microphone</h2>
        <p>
          Hear your microphone streamed back from the server. Use headphones to
          avoid feedback.
        </p>
        {!microphoneSupported() && (
          <p>
            Microphone streaming requires Web Audio and microphone access on
            HTTPS or localhost.
          </p>
        )}
        <button
          disabled={
            !microphoneSupported() ||
            socketStatus.state !== 'connected' ||
            !['idle', 'error'].includes(voiceStatus.state)
          }
          onClick={() => void voice.current?.start()}
        >
          Start microphone
        </button>
        <button
          disabled={
            !['requesting permission', 'streaming'].includes(voiceStatus.state)
          }
          onClick={() => void voice.current?.stop()}
        >
          Stop microphone
        </button>
        <p role="status" aria-label="Microphone status">
          Microphone {voiceStatus.state}
          {voiceStatus.state === 'streaming' &&
            !!voiceStatus.chunksSent &&
            ' · Audio received by server'}
        </p>
        {voiceStatus.error && <p role="alert">{voiceStatus.error}</p>}
        {playbackIssue && <p role="alert">{playbackIssue}</p>}
        {playbackIssue && (
          <button onClick={() => void voice.current?.enableAudio()}>
            Enable audio
          </button>
        )}
      </section>
      <section aria-labelledby="backend-title">
        <h2 id="backend-title">Backend connectivity</h2>
        <p>Check the connection to your configured backend.</p>
        <button onClick={check} disabled={loading}>
          {loading ? 'Checking…' : 'Check backend'}
        </button>
        <p role="status" aria-label="Backend health status">
          {status}
        </p>
      </section>
    </main>
  );
}

export default App;
