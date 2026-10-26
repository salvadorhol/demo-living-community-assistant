import type {TranscriptUpdate} from './index';
export interface ReviewSuggestion {
  priority: 'high' | 'medium' | 'low';
  target: 'prompt' | 'instructions' | 'tools';
  observation: string;
  recommendation: string;
  suggestedWording: string;
  evidenceIds: string[];
}
export interface CallReview {
  overallScore: number | null;
  summary: string;
  strengths: string[];
  limitations: string[];
  categories: {
    name: string;
    score: number | null;
    explanation: string;
    evidenceIds: string[];
  }[];
  suggestions: ReviewSuggestion[];
}
export interface ReviewAttempt {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt?: string;
  leaseUntil: number;
  model: string;
  rubricVersion: string;
  transcriptFingerprint: string;
  requestedBy: string;
  result?: CallReview;
  error?: string;
}
export interface ReviewCallSummary {
  uid: string;
  callId: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
  recordingStatus: string;
  durationMs: number | null;
  transcriptionStatus: string;
  latestReviewScore: number | null;
}
export interface ReviewCallDetail extends ReviewCallSummary {
  transcripts: TranscriptUpdate[];
  attempt: ReviewAttempt | null;
  latestReview: ReviewAttempt | null;
}
export interface ReviewCallKey {
  uid: string;
  callId: string;
}
export type ReviewAudioAccess =
  | {kind: 'signed-url'; url: string; expiresAt: number}
  | {kind: 'storage'; bucket: string; objectPath: string; sizeBytes: number};
export interface ReviewCallPage {
  calls: ReviewCallSummary[];
  nextCursor: {startedAt: string; path: string} | null;
}

export interface DeleteCallResult extends ReviewCallKey {
  deleted: true;
}
