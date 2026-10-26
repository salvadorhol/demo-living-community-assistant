export interface HealthResponse {
  status: 'ok';
  time: number;
}

export interface VoiceRoomSession {
  roomId: string;
}

export interface CallStatus {
  callId: string;
  state: 'active' | 'paused' | 'closing' | 'saving' | 'saved' | 'failed';
  endReason?: string;
  transcription?: 'available' | 'degraded';
  message?: string;
}

export interface ClientToServerEvents {
  'call:end': (
    value: { callId: string },
    ack: (result: AudioAck) => void,
  ) => void;
  'call:retry': (
    value: { callId: string },
    ack: (result: AudioAck) => void,
  ) => void;
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
  'audio:playback:progress': (progress: AudioPlaybackProgress) => void;
  'health:check': (acknowledge: (response: HealthResponse) => void) => void;
}

/** Full text snapshot for one utterance; IDs remain stable across partial updates. */
export interface TranscriptUpdate {
  /** Server-assigned ISO 8601 time of the first transcript update; stable across revisions.
   * Optional for older messages and provider events before the call assigns metadata.
   */
  createdAt?: string;
  callId?: string;
  order?: number;
  revision?: number;
  interrupted?: boolean;
  incomplete?: boolean;
  id: string;
  role: 'user' | 'assistant';
  text: string;
  isFinal: boolean;
}

export interface ServerToClientEvents {
  'call:status': (status: CallStatus) => void;
  'call:closing': (value: {
    callId: string;
    reason: 'demo_sales_handoff';
  }) => void;
  'transcript:update': (update: TranscriptUpdate) => void;
  'voice:session:error': (error: VoiceSessionError) => void;
  'voice:session:warning': (warning: VoiceSessionWarning) => void;
  'voice:session:ready': (session: VoiceRoomSession) => void;
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
  | 'AUDIO_FAILED'
  | 'VOICE_CONFIGURATION_ERROR';
export type AudioAck =
  { ok: true } | { ok: false; code: AudioErrorCode; message: string };
export type AudioOutputEvent =
  | { type: 'closing'; callId: string; reason: 'demo_sales_handoff' }
  | { type: 'start'; stream: AudioStream }
  | { type: 'chunk'; chunk: AudioChunk }
  | { type: 'end'; streamId: string }
  | { type: 'clear'; streamId: string }
  | { type: 'error'; error: VoiceSessionError }
  | { type: 'warning'; warning: VoiceSessionWarning };

export interface AudioPlaybackProgress {
  streamId: string;
  playedMs: number;
  cleared?: boolean;
}
export interface VoiceSessionError {
  code: 'VOICE_UNAVAILABLE' | 'VOICE_CONFIGURATION_ERROR';
  message: string;
}

export interface VoiceSessionWarning {
  code: 'VOICE_OUTPUT_LIMIT';
  message: string;
}

/** Availability lookups do not create bookings. */
export interface AvailableAppointmentsResponse {
  timeZone: string;
  appointments: {
    id: string;
    date: string;
    startsAt: string;
    localTime?: string;
    durationMinutes: number;
  }[];
}
export interface SalesDirectorAvailabilityResponse {
  available: boolean;
}
export interface AvailableFloorPlansResponse {
  floorPlans: {
    id: string;
    name: string;
    bedrooms: number;
    bathrooms: number | null;
    available: true;
  }[];
  unknown: string[];
}

export type CommunityCategory =
  | 'pricing'
  | 'amenities'
  | 'care'
  | 'payments'
  | 'policies'
  | 'contact'
  | 'careers';
export interface CommunityInformationResponse {
  category: CommunityCategory;
  facts: Record<string, unknown>;
  notProvided: string[];
}
export interface ContactProfile {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}
export interface ContactInformationResponse {
  profile: ContactProfile;
}
export interface FollowUpResponse {
  requestId: string;
  status: 'pending';
  kind: 'tour' | 'callback';
}
