import type { Socket } from 'socket.io';
import type {
  AudioAck,
  AudioOutputEvent,
  ClientToServerEvents,
  ServerToClientEvents,
} from '@living-community-assistant/types';

/** A future provider adapter owns its upstream session here. No audio is retained by default. */
export interface AudioSession {
  start(): void | Promise<void>;
  write(data: Uint8Array): void | Promise<void>;
  stop(): void | Promise<void>;
  dispose(): void;
}
export type AudioSessionFactory = (context: {
  uid: string;
  streamId: string;
  output: (event: AudioOutputEvent) => void;
}) => AudioSession;
/*
 * FUTURE OPENAI ADAPTER — outline only; echoAudio below remains active.
 * Implement this as openai-audio.ts, then select it in main.ts. One factory
 * instance belongs to one authenticated microphone stream; never share an
 * upstream connection between clients. `uid` is the verified Firebase identity.
 *
 * This outline targets the Realtime API conversation protocol, not GPT-Live's
 * different session.* events. A transcription-only session produces text,
 * not spoken responses; add a separate transcript contract if that is needed.
 * Official OpenAI documentation:
 * https://developers.openai.com/api/docs/guides/voice-websockets
 * https://developers.openai.com/api/docs/guides/realtime-conversations
 * https://developers.openai.com/api/docs/guides/realtime-transcription
 *
 * export const openaiAudio: AudioSessionFactory = ({ uid, streamId, output }) => {
 *   // Own the upstream socket, output sequence, timers, and disposed flag here.
 *   return {
 *     async start() {
 *       // Connect to wss://api.openai.com/v1/realtime?model=<configured model>.
 *       // Use a server-side WebSocket client supporting Authorization headers;
 *       // read OPENAI_API_KEY on the server, never from frontend environment files.
 *       // Register message/error/close handlers BEFORE waiting for the connection.
 *       // Send session.update: type 'realtime', output_modalities ['audio'],
 *       // audio.input/output.format { type: 'audio/pcm', rate: 24000 }.
 *       // For this Start/Stop UI, set audio.input.turn_detection to null.
 *       // Resolve only after session.updated; bound setup below our 2s ack limit.
 *     },
 *     async write(data) {
 *       // `data` is already mono PCM16LE at 24 kHz. No WAV/Opus decoding needed.
 *       // Send JSON through the upstream socket, NOT the browser Socket.IO socket:
 *       // { type: 'input_audio_buffer.append',
 *       //   audio: Buffer.from(data).toString('base64') }
 *       // Resolve when locally sent; OpenAI does not acknowledge each append.
 *       // Bound upstream queued bytes and reject on send failure/backpressure.
 *     },
 *     async stop() {
 *       // With VAD disabled: send input_audio_buffer.commit, then response.create.
 *       // Skip an empty/too-short input buffer according to the API requirements.
 *       // Finish sending promptly; don't await the model response in this ack.
 *       // KEEP receiving output after Stop; closing here would truncate speech.
 *     },
 *     dispose() {
 *       // Mark disposed, cancel pending work, remove handlers/timers, and close
 *       // the upstream socket synchronously. Do not reconnect/replay old audio.
 *     },
 *   };
 * };
 *
 * In the upstream message handler:
 * - On the first response.output_audio.delta for an output item, call
 *   output({ type: 'start', stream: { streamId: outputId, format: PCM_FORMAT } });
 *   PCM_FORMAT is { encoding: 'pcm16le', sampleRate: 24000, channels: 1 }.
 * - Decode event.delta with Buffer.from(event.delta, 'base64'). Split into
 *   even-length chunks <= 4800 bytes; publish output({ type: 'chunk', chunk:
 *   { streamId: outputId, sequence: nextSequence++, data: bytes } }).
 *   Use a distinct outputId per audio item and reset its sequence to zero.
 * - On response.output_audio.done, publish output({ type: 'end', streamId:
 *   outputId }); on interruption/failure, publish 'clear' instead.
 * - Handle OpenAI error events and unexpected closes explicitly; the current
 *   callback only carries audio. Add a typed async error event before enabling
 *   a live provider, so failures after start() reach the UI too.
 * - Ignore late messages after disposal. attachAudio scopes callbacks to this
 *   client and clears scheduled playback on cancellation/replacement.
 */

/** Stream each validated chunk straight back to its originating client. */
export const echoAudio: AudioSessionFactory = ({ streamId, output }) => {
  let sequence = 0;
  let active = false;
  return {
    start() {
      active = true;
      output({
        type: 'start',
        stream: {
          streamId,
          format: { encoding: 'pcm16le', sampleRate: 24000, channels: 1 },
        },
      });
    },
    write(data) {
      if (active)
        output({
          type: 'chunk',
          chunk: { streamId, sequence: sequence++, data },
        });
    },
    stop() {
      active = false;
      output({ type: 'end', streamId });
    },
    dispose() {
      active = false;
    },
  };
};

type AudioSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  { uid: string }
>;

export function validFormat(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const format = value as Record<string, unknown>;
  return (
    format.encoding === 'pcm16le' &&
    format.sampleRate === 24000 &&
    format.channels === 1
  );
}
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 128;
const fail = (
  code: Exclude<AudioAck, { ok: true }>['code'],
  message: string,
): AudioAck => ({ ok: false, code, message });

export function attachAudio(socket: AudioSocket, factory: AudioSessionFactory) {
  let current:
    | {
        streamId: string;
        session: AudioSession;
        outputStreamId?: string;
        sequence: number;
        accepting: boolean;
        busy: boolean;
      }
    | undefined;
  function dispose() {
    const old = current;
    current = undefined; // Invalidate callbacks before disposing the provider.
    if (old?.outputStreamId && socket.connected)
      socket.emit('audio:output:clear', { streamId: old.outputStreamId });
    try {
      old?.session.dispose();
    } catch {
      /* Cleanup must not take down the socket server. */
    }
  }
  socket.on('audio:input:start', async (value, ack) => {
    if (typeof ack !== 'function') return;
    if (!value || !validId(value.streamId) || !validFormat(value.format)) {
      ack(fail('INVALID_AUDIO', 'Expected mono PCM16 at 24 kHz.'));
      return;
    }
    if (current?.accepting || current?.busy) {
      ack(fail('BUSY', 'An input stream is already active.'));
      return;
    }
    dispose();
    const stream = {
      streamId: value.streamId,
      sequence: 0,
      accepting: true,
      busy: true,
      session: undefined as unknown as AudioSession,
    };
    try {
      current = stream;
      stream.session = factory({
        uid: socket.data.uid,
        streamId: value.streamId,
        output(event) {
          if (current !== stream || !socket.connected) return;
          switch (event.type) {
            case 'start':
              if (current) current.outputStreamId = event.stream.streamId;
              socket.emit('audio:output:start', event.stream);
              break;
            case 'chunk':
              socket.emit('audio:output:chunk', event.chunk);
              break;
            case 'end':
              socket.emit('audio:output:end', { streamId: event.streamId });
              break;
            case 'clear':
              socket.emit('audio:output:clear', { streamId: event.streamId });
              break;
          }
        },
      });
      await stream.session.start();
      if (current !== stream) return;
      stream.busy = false;
      ack({ ok: true });
    } catch {
      if (current === stream) dispose();
      ack(fail('AUDIO_FAILED', 'Audio session could not start.'));
    }
  });
  socket.on('audio:input:chunk', async (value, ack) => {
    if (typeof ack !== 'function') return;
    const stream = current;
    if (!stream?.accepting || !value || value.streamId !== stream.streamId) {
      ack(fail('INVALID_STREAM', 'No matching input stream.'));
      return;
    }
    if (stream.busy) {
      ack(fail('BUSY', 'Wait for the previous acknowledgement.'));
      return;
    }
    if (
      !Number.isSafeInteger(value.sequence) ||
      value.sequence !== stream.sequence ||
      !(value.data instanceof Uint8Array) ||
      !value.data.byteLength ||
      value.data.byteLength % 2 !== 0 ||
      value.data.byteLength > 4800
    ) {
      ack(fail('INVALID_AUDIO', 'Invalid PCM chunk or sequence.'));
      return;
    }
    stream.busy = true;
    try {
      await stream.session.write(value.data);
      if (current !== stream) return;
      stream.sequence++;
      stream.busy = false;
      ack({ ok: true });
    } catch {
      if (current === stream) dispose();
      ack(fail('AUDIO_FAILED', 'Audio input failed.'));
    }
  });
  socket.on('audio:input:stop', async (value, ack) => {
    if (typeof ack !== 'function') return;
    const stream = current;
    if (!stream?.accepting || value?.streamId !== stream.streamId) {
      ack(fail('INVALID_STREAM', 'No matching input stream.'));
      return;
    }
    if (value.cancel) {
      dispose();
      ack({ ok: true });
      return;
    }
    if (stream.busy) {
      ack(fail('BUSY', 'Wait for the previous acknowledgement.'));
      return;
    }
    stream.accepting = false;
    stream.busy = true;
    try {
      await stream.session.stop();
      if (current !== stream) return;
      stream.busy = false;
      ack({ ok: true });
    } catch {
      if (current === stream) dispose();
      ack(fail('AUDIO_FAILED', 'Audio input could not stop.'));
    }
  });
  socket.on('disconnect', dispose);
}
