import { useState } from 'react';
import { checkHealth } from './api/health';
import styles from './app.module.scss';

export function App() {
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
      <section aria-labelledby="backend-title">
        <h2 id="backend-title">Backend connectivity</h2>
        <p>Check the connection to your configured backend.</p>
        <button onClick={check} disabled={loading}>
          {loading ? 'Checking…' : 'Check backend'}
        </button>
        <p role="status">{status}</p>
      </section>
    </main>
  );
}

export default App;
