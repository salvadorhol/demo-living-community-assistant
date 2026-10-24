import { randomUUID } from 'node:crypto';
import type {
  AudioOutputEvent,
  AudioPlaybackProgress,
} from '@living-community-assistant/types';
import type { AppLogger } from '../../logger.ts';
const FORMAT = { encoding: 'pcm16le', sampleRate: 24000, channels: 1 } as const;
export type PlaybackItem = {
  id: string;
  itemId: string;
  contentIndex: number;
  responseId: string;
  sequence: number;
  bytes: number;
  playedMs: number;
  queue: Buffer[];
  queuedBytes: number;
  done: boolean;
  startedAt: number;
  lastQueueLog: number;
  peakQueuedBytes: number;
  highWaterLogged: boolean;
};
export class OutputPlayback {
  private current?: PlaybackItem;
  private interrupted?: PlaybackItem;
  private truncateTimer?: ReturnType<typeof setTimeout>;
  private pumpTimer?: ReturnType<typeof setInterval>;
  private maxOutputQueueMs: number;
  private maxOutputQueueBytes: number;
  private logger: AppLogger;
  private output: (event: AudioOutputEvent) => void;
  private onFailure: (error: unknown) => void;
  private onLimit: () => void;
  private onInterrupted: (item: PlaybackItem, cancelResponse: boolean) => void;
  private onTruncate: (item: PlaybackItem) => void;
  constructor(options: {
    maxOutputQueueMs: number;
    logger: AppLogger;
    output: (event: AudioOutputEvent) => void;
    onFailure(error: unknown): void;
    onLimit(): void;
    onInterrupted(item: PlaybackItem, cancelResponse: boolean): void;
    onTruncate(item: PlaybackItem): void;
  }) {
    this.maxOutputQueueMs = options.maxOutputQueueMs;
    this.maxOutputQueueBytes = options.maxOutputQueueMs * 48;
    this.logger = options.logger;
    this.output = options.output;
    this.onFailure = options.onFailure;
    this.onLimit = options.onLimit;
    this.onInterrupted = options.onInterrupted;
    this.onTruncate = options.onTruncate;
  }
  setLogger(logger: AppLogger) {
    this.logger = logger;
  }
  get target(): PlaybackItem | undefined {
    return this.current;
  }
  get responseId(): string | undefined {
    const item = this.current;
    return item &&
      (item.queuedBytes > 0 || !item.done || item.playedMs < item.bytes / 48)
      ? item.responseId
      : undefined;
  }
  get truncationTarget(): PlaybackItem | undefined {
    return this.interrupted;
  }
  private truncate() {
    clearTimeout(this.truncateTimer);
    const item = this.interrupted;
    this.interrupted = undefined;
    if (item) this.onTruncate(item);
  }
  flushTruncation() {
    this.truncate();
  }
  interrupt(cancelResponse = true): PlaybackItem | undefined {
    if (!this.current) return undefined;
    if (this.interrupted) this.truncate();
    const item = this.current;
    this.interrupted = item;
    this.onInterrupted(item, cancelResponse);
    this.current = undefined;
    clearInterval(this.pumpTimer);
    this.pumpTimer = undefined;
    // Drop buffered PCM immediately; retain only playback identity for truncation.
    item.queue = [];
    item.queuedBytes = 0;
    this.output({ type: 'clear', streamId: item.id });
    this.truncateTimer = setTimeout(() => {
      try {
        this.truncate();
      } catch (err) {
        this.onFailure(err);
      }
    }, 250);
    return item;
  }
  append(event: {
    item_id: string;
    content_index: number;
    response_id: string;
    delta: string;
  }) {
    if (
      !this.current ||
      this.current.itemId !== event.item_id ||
      this.current.contentIndex !== event.content_index
    ) {
      if (this.current) this.interrupt(false);
      this.current = {
        id: randomUUID(),
        itemId: event.item_id,
        contentIndex: event.content_index as number,
        responseId: String(event.response_id),
        sequence: 0,
        bytes: 0,
        playedMs: 0,
        queue: [],
        queuedBytes: 0,
        done: false,
        startedAt: Date.now(),
        lastQueueLog: Date.now(),
        peakQueuedBytes: 0,
        highWaterLogged: false,
      };
      this.output({
        type: 'start',
        stream: { streamId: this.current.id, format: FORMAT },
      });
    }
    // Bound decoded allocation before accepting an unusually large provider event.
    const estimatedBytes =
      Math.floor((event.delta.length * 3) / 4) -
      (event.delta.endsWith('==') ? 2 : event.delta.endsWith('=') ? 1 : 0);
    if (this.current.queuedBytes + estimatedBytes > this.maxOutputQueueBytes) {
      this.cancelOversizedReply(estimatedBytes);
      return;
    }
    const data = Buffer.from(event.delta, 'base64');
    if (!data.length || data.length % 2) throw new Error('Invalid PCM output');
    this.current.bytes += data.length;
    this.current.queuedBytes += data.length;
    this.current.peakQueuedBytes = Math.max(
      this.current.peakQueuedBytes,
      this.current.queuedBytes,
    );
    if (
      !this.current.highWaterLogged &&
      this.current.queuedBytes >= this.maxOutputQueueBytes * 0.75
    ) {
      this.current.highWaterLogged = true;
      this.logger.warn(
        { event: 'voice.output_queue_high', ...this.queueStats(this.current) },
        'Voice output buffer nearing limit',
      );
    }
    // Pace delivery at the recorded sample rate, avoiding normal generation bursts
    // overflowing the browser's two-second playback budget.
    for (let offset = 0; offset < data.length; offset += 1920)
      this.current.queue.push(data.subarray(offset, offset + 1920));
    if (!this.pumpTimer)
      this.pumpTimer = setInterval(() => {
        try {
          this.pump();
        } catch (err) {
          this.onFailure(err);
        }
      }, 40);
  }
  complete(itemId: string) {
    if (this.current?.itemId === itemId) this.current.done = true;
  }
  generationFinished(responseId: string, status: string) {
    if (this.current?.responseId === responseId)
      this.logger.debug(
        {
          event: 'voice.response_done',
          ...this.queueStats(this.current),
          status,
        },
        'Voice response generation finished',
      );
  }
  progress(value: AudioPlaybackProgress) {
    const item =
      this.interrupted?.id === value.streamId
        ? this.interrupted
        : this.current?.id === value.streamId
          ? this.current
          : undefined;
    if (
      !item ||
      value.playedMs < item.playedMs ||
      value.playedMs > item.bytes / 48
    )
      return;
    item.playedMs = value.playedMs;
    if (item === this.interrupted && value.cleared === true) this.truncate();
  }
  dispose() {
    if (this.current) this.output({ type: 'clear', streamId: this.current.id });
    clearTimeout(this.truncateTimer);
    clearInterval(this.pumpTimer);
    this.current = undefined;
    this.interrupted = undefined;
  }
  private queueStats(item: PlaybackItem) {
    const elapsedMs = Math.max(1, Date.now() - item.startedAt);
    return {
      responseId: item.responseId,
      queuedBytes: item.queuedBytes,
      queuedMs: Math.round(item.queuedBytes / 48),
      peakQueuedMs: Math.round(item.peakQueuedBytes / 48),
      generatedMs: Math.round(item.bytes / 48),
      deliveredMs: Math.round((item.bytes - item.queuedBytes) / 48),
      elapsedMs,
      generationRate: Math.round((item.bytes / 48 / elapsedMs) * 100) / 100,
      deliveryRate:
        Math.round(((item.bytes - item.queuedBytes) / 48 / elapsedMs) * 100) /
        100,
      limitMs: this.maxOutputQueueMs,
    };
  }
  private cancelOversizedReply(incomingBytes: number) {
    if (!this.current) return;
    this.logger.warn(
      {
        event: 'voice.output_limit',
        ...this.queueStats(this.current),
        incomingBytes,
      },
      'Assistant reply exceeded output buffer; cancelling reply, keeping call active',
    );
    this.onLimit();
    this.output({
      type: 'warning',
      warning: {
        code: 'VOICE_OUTPUT_LIMIT',
        message:
          'The assistant reply was too long and was stopped. You can keep speaking or ask for a shorter answer.',
      },
    });
  }
  private pump() {
    const item = this.current;
    if (!item) return;
    const parts: Buffer[] = [];
    let size = 0;
    while (item.queue.length && size < 1920) {
      const head = item.queue[0];
      const take = Math.min(head.length, 1920 - size);
      parts.push(head.subarray(0, take));
      size += take;
      if (take === head.length) item.queue.shift();
      else item.queue[0] = head.subarray(take);
    }
    if (size) {
      const data = Buffer.concat(parts);
      item.queuedBytes -= data.byteLength;
      this.output({
        type: 'chunk',
        chunk: { streamId: item.id, sequence: item.sequence++, data },
      });
    }
    if (Date.now() - item.lastQueueLog >= 1000) {
      this.logger.debug(
        { event: 'voice.output_queue', ...this.queueStats(item) },
        'Voice output queue',
      );
      item.lastQueueLog = Date.now();
    }
    if (item.done && !item.queue.length) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = undefined;
      this.output({ type: 'end', streamId: item.id });
    }
  }
}
