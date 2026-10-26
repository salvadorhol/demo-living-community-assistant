import { useEffect, useState } from 'react';
import { useNavigate, useBlocker } from 'react-router-dom';
import type { SophiePrompt } from '@living-community-assistant/types/prompt';
import {
  MAX_PROMPT_LENGTH,
  validPromptContent,
} from '@living-community-assistant/types/prompt';
import { loadPrompt, savePrompt } from './api/prompt';
import { lockApp } from './api/session';
import styles from './app.module.scss';
import { AppointmentsEditor } from './appointments-editor';

export function AdminPage() {
  const navigate = useNavigate();
  const [saved, setSaved] = useState<SophiePrompt | null>();
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [appointmentsDirty, setAppointmentsDirty] = useState(false);
  const [appointmentsBusy, setAppointmentsBusy] = useState(false);
  const promptDirty = saved !== undefined && draft !== (saved?.content ?? '');
  const dirty = promptDirty || appointmentsDirty;
  const blocker = useBlocker(dirty && !busy);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard your unsaved prompt changes?'))
      blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void loadPrompt()
      .then((value) => {
        if (!disposed) {
          setSaved(value);
          setDraft(value?.content ?? '');
        }
      })
      .catch(() => {
        if (!disposed) setError('Could not load the prompt. Please retry.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const discardAllowed = () =>
    !dirty || window.confirm('Discard your unsaved prompt changes?');
  return (
    <main className={styles['page']}>
      <header className={styles['header']}>
        <h1>Sophie prompt administration</h1>
        <div className={styles['connection']}>
          <button
            disabled={busy || appointmentsBusy}
            onClick={() => {
              navigate('/');
            }}
          >
            Open assistant
          </button>
          <button
            disabled={busy || appointmentsBusy}
            onClick={() => {
              if (discardAllowed())
                void lockApp().catch(() =>
                  setError('Could not sign out. Please retry.'),
                );
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <p>
        Saved changes apply to new calls. Active calls keep their starting
        prompt.
      </p>
      {loading ? (
        <p role="status">Loading prompt…</p>
      ) : saved === undefined ? (
        <button onClick={() => setAttempt((value) => value + 1)}>
          Retry loading prompt
        </button>
      ) : (
        <>
          {saved ? (
            <p>
              Revision {saved.revision} · Saved{' '}
              {new Date(saved.updatedAt.toMillis()).toLocaleString()}
            </p>
          ) : (
            <p>No prompt is saved. New calls are blocked until you save one.</p>
          )}
          <form
            className={styles['promptEditor']}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !promptDirty || !validPromptContent(draft)) return;
              setBusy(true);
              setError(undefined);
              setMessage(undefined);
              void savePrompt(draft, saved?.revision ?? 0)
                .then(async () => {
                  // The write succeeded even if the following refresh fails: never offer
                  // an old revision for another save in that case.
                  setSaved(undefined);
                  const latest = await loadPrompt();
                  setSaved(latest);
                  setDraft(latest?.content ?? '');
                  setMessage(
                    'Prompt saved. New calls will use the saved version.',
                  );
                })
                .catch((failure: unknown) =>
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : 'Could not save the prompt. Please retry.',
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label htmlFor="sophie-prompt">Sophie’s prompt</label>
            <textarea
              id="sophie-prompt"
              rows={24}
              maxLength={MAX_PROMPT_LENGTH}
              value={draft}
              disabled={busy || appointmentsBusy}
              onChange={(event) => setDraft(event.target.value)}
            />
            <p>
              {draft.length.toLocaleString()} /{' '}
              {MAX_PROMPT_LENGTH.toLocaleString()} characters
            </p>
            <div>
              <button
                type="submit"
                disabled={busy || !promptDirty || !validPromptContent(draft)}
              >
                {busy ? 'Saving…' : 'Save prompt'}
              </button>
              <button
                type="button"
                disabled={busy || appointmentsBusy}
                onClick={() => {
                  if (
                    !promptDirty ||
                    window.confirm('Discard your unsaved prompt changes?')
                  ) {
                    setMessage(undefined);
                    setAttempt((value) => value + 1);
                  }
                }}
              >
                Discard changes
              </button>
            </div>
          </form>
        </>
      )}
      <AppointmentsEditor
        onDirty={setAppointmentsDirty}
        onBusy={setAppointmentsBusy}
      />
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
