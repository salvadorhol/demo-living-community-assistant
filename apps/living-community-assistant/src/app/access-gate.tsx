import { useEffect, useState, type ReactNode } from 'react';
import { observeAccess, unlockApp } from './api/session';
import styles from './app.module.scss';

export function AccessGate({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(
    () =>
      observeAccess(
        (user, issue) => {
          setAllowed(Boolean(user));
          setLoading(false);
          setError(issue);
        },
        admin ? 'admin' : 'appAccess',
      ),
    [attempt, admin],
  );

  if (allowed) return children;
  return (
    <main className={styles['page']}>
      <h1>
        {admin ? 'Sophie prompt administration' : 'Living Community Assistant'}
      </h1>
      {loading ? (
        <p role="status">Checking access…</p>
      ) : (
        <section className={styles['access']} aria-label="Password required">
          <h2>
            {admin ? 'Enter the admin password' : 'Enter the access password'}
          </h2>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (submitting) return;
              setSubmitting(true);
              setError(undefined);
              const submitted = password;
              setPassword('');
              void unlockApp(submitted, admin)
                .catch((failure: unknown) => {
                  const code = (failure as { code?: string })?.code;
                  setError(
                    code === 'functions/permission-denied'
                      ? 'Incorrect password. Please try again.'
                      : 'Could not sign in. Please retry.',
                  );
                })
                .finally(() => setSubmitting(false));
            }}
          >
            <label htmlFor="access-password">Password</label>
            <input
              id="access-password"
              type="password"
              autoComplete="current-password"
              required
              disabled={submitting}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <button
              className={styles['primary']}
              disabled={submitting}
              type="submit"
            >
              {submitting ? 'Signing in…' : 'Unlock'}
            </button>
          </form>
          {error && <p role="alert">{error}</p>}
          {error && (
            <button onClick={() => setAttempt((value) => value + 1)}>
              Retry access check
            </button>
          )}
        </section>
      )}
    </main>
  );
}
