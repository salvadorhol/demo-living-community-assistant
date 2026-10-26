import { useEffect, useState } from 'react';
import type { AppointmentsConfig } from '@living-community-assistant/types/appointments';
import { validateAppointmentSlots } from '@living-community-assistant/types/appointments';
import { loadAppointments, saveAppointments } from './api/appointments';
import styles from './app.module.scss';
export function AppointmentsEditor({
  onDirty,
  onBusy,
}: {
  onDirty(dirty: boolean): void;
  onBusy(busy: boolean): void;
}) {
  const [saved, setSaved] = useState<AppointmentsConfig | null>();
  const [draft, setDraft] = useState('[]');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const baseline = JSON.stringify(saved?.slots ?? [], null, 2);
  const dirty = saved !== undefined && draft !== baseline;
  let validation: string | undefined;
  try {
    validateAppointmentSlots(JSON.parse(draft));
  } catch (e) {
    validation = e instanceof Error ? e.message : 'Invalid JSON array.';
  }
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void loadAppointments()
      .then((value) => {
        if (!disposed) {
          setSaved(value);
          setDraft(JSON.stringify(value?.slots ?? [], null, 2));
        }
      })
      .catch(() => {
        if (!disposed) setError('Could not load appointments. Please retry.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [attempt]);
  return (
    <section aria-label="Appointment configuration">
      <h2>Available appointments</h2>
      <p>
        Edit up to 20 date/time options in America/New_York. Each appointment is
        30 minutes. Past slots are not offered. An empty array means no
        appointments are available.
      </p>
      {loading ? (
        <p role="status">Loading appointments…</p>
      ) : saved === undefined ? (
        <button onClick={() => setAttempt((n) => n + 1)}>
          Retry loading appointments
        </button>
      ) : (
        <>
          {saved ? (
            <p>
              Appointments revision {saved.revision} · Saved{' '}
              {new Date(saved.updatedAt.toMillis()).toLocaleString()}
            </p>
          ) : (
            <p>
              No configuration is saved yet. Save the array to enable
              appointment lookups.
            </p>
          )}
          <form
            className={styles['promptEditor']}
            onSubmit={(e) => {
              e.preventDefault();
              if (busy || validation || (!dirty && saved !== null)) return;
              setBusy(true);
              setError(undefined);
              setMessage(undefined);
              void saveAppointments(draft, saved?.revision ?? 0)
                .then(async () => {
                  setSaved(undefined);
                  const latest = await loadAppointments();
                  setSaved(latest);
                  setDraft(JSON.stringify(latest?.slots ?? [], null, 2));
                  setMessage(
                    'Appointments saved. The next lookup will use these options.',
                  );
                })
                .catch((e: unknown) =>
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Could not save appointments.',
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            <label htmlFor="appointments-json">Appointments JSON</label>
            <textarea
              id="appointments-json"
              rows={10}
              maxLength={10000}
              disabled={busy}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
            />
            <p>Example: {'[{"date":"2026-11-02","time":"10:00"}]'}</p>
            {validation && <p role="alert">{validation}</p>}
            <div>
              <button
                disabled={busy || (!dirty && saved !== null) || !!validation}
                type="submit"
              >
                {busy ? 'Saving appointments…' : 'Save appointments'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    !dirty ||
                    window.confirm('Discard unsaved appointment changes?')
                  ) {
                    setMessage(undefined);
                    setAttempt((n) => n + 1);
                  }
                }}
              >
                Discard appointment changes
              </button>
            </div>
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
