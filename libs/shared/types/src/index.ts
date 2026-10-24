export interface HealthResponse {
  status: 'ok';
  time: number;
}

export interface ClientToServerEvents {
  'audio:input:start': (
    stream: AudioStream,
    ack: (result: AudioAck) => void,
  ) => void;
  'audio:input:chunk': (
    chunk: AudioChunk,
    ack: (result: AudioAck) => void,
  ) => void;
  'audio:input:stop': (
    stream: AudioStreamEnd & { cancel?: boolean },
    ack: (result: AudioAck) => void,
  ) => void;
  'health:check': (acknowledge: (response: HealthResponse) => void) => void;
}

export interface ServerToClientEvents {
  'audio:output:start': (stream: AudioStream) => void;
  'audio:output:chunk': (chunk: AudioChunk) => void;
  'audio:output:end': (stream: AudioStreamEnd) => void;
  'audio:output:clear': (stream: AudioStreamEnd) => void;
  'health:status': (response: HealthResponse) => void;
}

export interface AudioFormat {
  encoding: 'pcm16le';
  sampleRate: 24000;
  channels: 1;
}
export interface AudioStream {
  streamId: string;
  format: AudioFormat;
}
export interface AudioChunk {
  streamId: string;
  sequence: number;
  data: Uint8Array;
}
export interface AudioStreamEnd {
  streamId: string;
}
export type AudioErrorCode =
  | 'INVALID_AUDIO'
  | 'INVALID_STREAM'
  | 'BUSY'
  | 'AUDIO_FAILED';
export type AudioAck =
  | { ok: true }
  | { ok: false; code: AudioErrorCode; message: string };
export type AudioOutputEvent =
  | { type: 'start'; stream: AudioStream }
  | { type: 'chunk'; chunk: AudioChunk }
  | { type: 'end'; streamId: string }
  | { type: 'clear'; streamId: string };
