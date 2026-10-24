import {
  mkdtempSync,
  openSync,
  closeSync,
  writeSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RATE = 24000;
const BYTES_PER_MS = 48;
interface Track {
  path: string;
  start: number;
  bytes: number;
  played: number;
  cleared: boolean;
}
/** Disk-backed, server-timeline capture; memory use is independent of call length. */
export class CallRecording {
  readonly directory = mkdtempSync(join(tmpdir(), 'community-call-'));
  readonly path = join(this.directory, 'recording.wav');
  private tracks = new Map<string, Track>();
  private started = performance.now();
  private ended?: number;
  private stopped?: number;
  private totalBytes = 0;
  private offset() {
    return Math.round(((performance.now() - this.started) * RATE) / 1000) * 2;
  }
  append(id: string, data: Uint8Array, microphone = false) {
    if (this.stopped !== undefined || this.ended !== undefined) return;
    this.totalBytes += data.byteLength;
    if (this.totalBytes > 3600000 * BYTES_PER_MS * 2)
      throw new Error('Recording size limit reached.');
    let track = this.tracks.get(id);
    if (!track) {
      if (this.tracks.size >= 4096)
        throw new Error('Recording track limit reached.');
      const path = join(this.directory, `track-${this.tracks.size}`);
      closeSync(openSync(path, 'w'));
      track = {
        path,
        start: Math.max(0, this.offset() - (microphone ? data.byteLength : 0)),
        bytes: 0,
        played: 0,
        cleared: false,
      };
      this.tracks.set(id, track);
    }
    if (track.cleared) return;
    // Resume/capture gaps create silence rather than moving subsequent audio earlier.
    const position = microphone
      ? Math.max(track.bytes, this.offset() - track.start - data.byteLength)
      : track.bytes;
    const fd = openSync(track.path, 'r+');
    try {
      writeSync(fd, data, 0, data.byteLength, position);
    } finally {
      closeSync(fd);
    }
    track.bytes = position + data.byteLength;
  }
  progress(id: string, playedMs: number) {
    const track = this.tracks.get(id);
    if (
      !track ||
      playedMs < track.played ||
      playedMs * BYTES_PER_MS > track.bytes
    )
      return;
    track.played = playedMs;
  }
  clear(id: string) {
    const track = this.tracks.get(id);
    if (!track) return;
    track.cleared = true;
  }
  stop() {
    this.stopped ??= this.offset();
  }
  async finish() {
    if (this.ended !== undefined) return;
    this.ended = this.stopped ?? this.offset();
    const length = this.ended;
    const output = openSync(this.path, 'w');
    try {
      const header = Buffer.alloc(44);
      header.write('RIFF');
      header.writeUInt32LE(36 + length, 4);
      header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);
      header.writeUInt16LE(1, 22);
      header.writeUInt32LE(RATE, 24);
      header.writeUInt32LE(RATE * 2, 28);
      header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34);
      header.write('data', 36);
      header.writeUInt32LE(length, 40);
      writeSync(output, header);
      const tracks = [...this.tracks.values()].map((track) => ({
        ...track,
        size: track.cleared
          ? Math.floor((track.played * BYTES_PER_MS) / 2) * 2
          : statSync(track.path).size,
      }));
      for (let offset = 0; offset < length; offset += 48000) {
        if (offset % 480000 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));
        const size = Math.min(48000, length - offset);
        const mixed = new Int32Array(size / 2);
        const counts = new Uint8Array(size / 2);
        for (const track of tracks) {
          const start = Math.max(offset, track.start);
          const end = Math.min(offset + size, track.start + track.size);
          if (end <= start) continue;
          const pcm = Buffer.alloc(end - start);
          const fd = openSync(track.path, 'r');
          try {
            readSync(fd, pcm, 0, pcm.length, start - track.start);
          } finally {
            closeSync(fd);
          }
          for (let i = 0; i < pcm.length; i += 2) {
            const index = (start - offset + i) / 2;
            mixed[index] += pcm.readInt16LE(i);
            counts[index]++;
          }
        }
        const pcm = Buffer.alloc(size);
        for (let i = 0; i < mixed.length; i++)
          pcm.writeInt16LE(
            Math.round(mixed[i] / Math.max(1, counts[i])),
            i * 2,
          );
        writeSync(output, pcm);
      }
    } catch (error) {
      this.ended = undefined;
      throw error;
    } finally {
      closeSync(output);
    }
  }
  get durationMs() {
    return (this.ended ?? this.offset()) / BYTES_PER_MS;
  }
  cleanup() {
    this.tracks.clear();
    rmSync(this.directory, { recursive: true, force: true });
  }
}
