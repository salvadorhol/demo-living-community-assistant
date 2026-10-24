import { silentLogger, type AppLogger } from './logger.ts';
import { randomUUID } from 'node:crypto';
import type {
  CallStatus,
  TranscriptUpdate,
} from '@living-community-assistant/types';
import { CallRecording } from './recording.ts';
import { retry, type CallStore } from './call-store.ts';
import { AGENT_CONFIG } from './agent-config.ts';

export class SavedCall {
  readonly id = randomUUID();
  readonly recording = new CallRecording();
  private queue: Promise<unknown> = Promise.resolve();
  private entries = new Map<string, TranscriptUpdate>();
  private checkpoints = new Map<string, number>();
  private order = 0;
  private closed = false;
  private saving?: Promise<void>;
  private transcription: 'available' | 'degraded' = 'available';
  private reason = 'ended';
  private endedAt?: string;
  private recordingReference?: Record<string, unknown>;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  state: CallStatus['state'] = 'active';
  readonly uid: string;
  private logger: AppLogger;
  private store: CallStore | undefined;
  private emit: (status: CallStatus) => void;
  private transcript: (value: TranscriptUpdate) => void;
  constructor(
    uid: string,
    store: CallStore | undefined,
    emit: (status: CallStatus) => void,
    transcript: (value: TranscriptUpdate) => void,
    logger: AppLogger = silentLogger,
  ) {
    this.logger = logger.child({ callId: this.id, component: 'call' });
    this.uid = uid;
    this.store = store;
    this.emit = emit;
    this.transcript = transcript;
  }

  private enqueue(
    operation: () => Promise<unknown>,
    operationName = 'checkpoint',
  ) {
    this.queue = this.queue
      .catch(() => undefined)
      .then(() => this.retry(operationName, operation));
    // Surface persistence failures on finalization, without unhandled background rejections.
    void this.queue.catch((err) =>
      this.logger.error(
        {
          event: 'persistence.checkpoint_failed',
          err,
          operation: operationName,
        },
        'Call checkpoint failed',
      ),
    );
    return this.queue;
  }
  private retry<T>(operation: string, action: () => Promise<T>) {
    return retry(action, (err, attempt) =>
      this.logger.warn(
        { event: 'persistence.retry', operation, attempt, err },
        'Retrying call persistence',
      ),
    );
  }
  async start(roomId: string, authentication: Record<string, unknown> = {}) {
    await this.enqueue(
      async () =>
        this.store?.start(this.uid, this.id, {
          roomId,
          ...authentication,
          status: 'active',
          recordingStatus: 'pending',
          model: AGENT_CONFIG.model,
          transcriptionModel: AGENT_CONFIG.transcriptionModel,
          startedAt: new Date().toISOString(),
        }),
      'start',
    );
    this.logger.info({ event: 'call.started', roomId }, 'Call started');
    this.notify('active');
  }
  private notify(state: CallStatus['state'], message?: string) {
    this.state = state;
    this.emit({
      callId: this.id,
      state,
      transcription: this.transcription,
      ...(message ? { message } : {}),
    });
  }
  pause(paused: boolean) {
    if (this.closed) return;
    const state = paused ? 'paused' : 'active';
    this.logger.info(
      { event: paused ? 'call.paused' : 'call.resumed' },
      paused ? 'Call paused' : 'Call resumed',
    );
    this.notify(paused ? 'paused' : 'active');
    void this.enqueue(
      async () => this.store?.update(this.uid, this.id, { status: state }),
      'status',
    );
  }
  metadata(info: Record<string, string>) {
    if (!this.closed)
      void this.enqueue(
        async () => this.store?.update(this.uid, this.id, info),
        'metadata',
      );
  }
  degraded() {
    if (this.closed) return;
    if (this.transcription === 'degraded') return;
    this.transcription = 'degraded';
    this.notify(
      this.state,
      'Live transcription is unavailable; audio recording continues.',
    );
    void this.enqueue(
      async () =>
        this.store?.update(this.uid, this.id, {
          transcriptionStatus: 'degraded',
        }),
      'transcription-status',
    );
  }
  update(value: TranscriptUpdate) {
    if (this.closed) return;
    const previous = this.entries.get(value.id);
    if (previous?.isFinal && !value.interrupted) return;
    const update = {
      ...value,
      callId: this.id,
      order: previous?.order ?? this.order++,
      revision: (previous?.revision ?? 0) + 1,
    };
    this.entries.set(value.id, update);
    this.transcript(update);
    const now = Date.now();
    if (update.isFinal || now - (this.checkpoints.get(value.id) ?? 0) >= 1000) {
      this.checkpoints.set(value.id, now);
      void this.enqueue(
        async () => this.store?.transcript(this.uid, this.id, update),
        'transcript',
      );
    }
  }
  ending() {
    this.endedAt ??= new Date().toISOString();
    this.recording.stop();
    this.notify('saving');
  }
  async finish(reason: string) {
    if (this.state === 'saved') return;
    if (this.saving) return this.saving;
    this.reason = this.closed ? this.reason : reason;
    this.endedAt ??= new Date().toISOString();
    if (!this.closed) {
      for (const entry of this.entries.values()) {
        if (!entry.isFinal)
          this.update({ ...entry, incomplete: true, isFinal: true });
      }
      this.closed = true;
    }
    this.notify('saving');
    this.saving = this.save().finally(() => {
      this.saving = undefined;
    });
    return this.saving;
  }
  private async save() {
    try {
      // Replay all final entries on retry, including any failed checkpoint writes.
      await this.queue.catch(() => undefined);
      await this.recording.finish();
      const store = this.store;
      if (store) {
        await this.retry('update', () =>
          store.update(this.uid, this.id, {
            status: 'saving',
            endedAt: this.endedAt,
            endReason: this.reason,
            transcriptionStatus: this.transcription,
          }),
        );
        for (const entry of this.entries.values())
          await this.retry('transcript', () =>
            store.transcript(this.uid, this.id, entry),
          );
        this.recordingReference ??= await this.retry('upload', () =>
          store.upload(
            this.uid,
            this.id,
            this.recording.path,
            this.recording.durationMs,
          ),
        );
        await this.retry('update', () =>
          store.update(this.uid, this.id, {
            status: 'ended',
            recordingStatus: 'saved',
            recording: this.recordingReference,
          }),
        );
      }
      this.logger.info(
        {
          event: 'call.saved',
          durationMs: this.recording.durationMs,
          bytes: this.recordingReference?.bytes,
        },
        'Call saved',
      );
      this.notify('saved');
      clearTimeout(this.cleanupTimer);
      this.recording.cleanup();
    } catch (err) {
      this.logger.error(
        { event: 'call.save_failed', err },
        'Call could not be saved',
      );
      this.notify(
        'failed',
        'Call could not be saved. Retry save while this server is running.',
      );
      await this.store
        ?.update(this.uid, this.id, {
          status: 'ended',
          recordingStatus: 'failed',
          endReason: this.reason,
          endedAt: this.endedAt,
        })
        .catch((err) =>
          this.logger.error(
            { event: 'persistence.failure_status_failed', err },
            'Could not persist save failure status',
          ),
        );
      // Bound retention of temporary artifacts after repeated failures.
      this.cleanupTimer ??= setTimeout(
        () => this.recording.cleanup(),
        60 * 60 * 1000,
      );
      this.cleanupTimer.unref();
    }
  }
}
