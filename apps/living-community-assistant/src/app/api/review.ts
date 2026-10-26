import {httpsCallable} from 'firebase/functions';
import {getBlob, ref} from 'firebase/storage';
import type {
  ReviewCallKey,
  ReviewCallPage,
  ReviewCallDetail,
  ReviewAttempt,
  DeleteCallResult,
  ReviewAudioAccess,
} from '@living-community-assistant/types';
import {functions, storage} from './firebase';

export interface LoadedReviewAudio {
  url: string;
  expiresAt?: number;
  dispose(): void;
}
// Matches the Functions metadata check and covers the current one-hour WAV limit.
const MAX_LOCAL_AUDIO_BYTES = 200 * 1024 * 1024;
export async function listReviewCalls(
  cursor?: ReviewCallPage['nextCursor']
): Promise<ReviewCallPage> {
  return (
    await httpsCallable<
      {cursor?: ReviewCallPage['nextCursor']},
      ReviewCallPage
    >(
      functions,
      'listReviewCalls'
    )({...(cursor ? {cursor} : {})})
  ).data;
}
export async function getReviewCall(
  key: ReviewCallKey
): Promise<ReviewCallDetail> {
  return (
    await httpsCallable<ReviewCallKey, ReviewCallDetail>(
      functions,
      'getReviewCall'
    )(key)
  ).data;
}
export async function getReviewAudio(
  key: ReviewCallKey
): Promise<LoadedReviewAudio> {
  const access = (
    await httpsCallable<ReviewCallKey, ReviewAudioAccess>(
      functions,
      'getReviewAudio'
    )(key)
  ).data;
  // Property-based discrimination also accepts older production signed URLs.
  if ('url' in access) return {...access, dispose: () => undefined};
  if (
    !Number.isSafeInteger(access.sizeBytes) ||
    access.sizeBytes < 0 ||
    access.sizeBytes > MAX_LOCAL_AUDIO_BYTES
  )
    throw new Error('Local playback supports recordings up to 200 MiB.');
  try {
    const blob = await getBlob(
      ref(storage, `gs://${access.bucket}/${access.objectPath}`),
      MAX_LOCAL_AUDIO_BYTES
    );
    if (blob.size !== access.sizeBytes)
      throw new Error('Recording download was incomplete.');
    const url = URL.createObjectURL(blob.slice(0, blob.size, 'audio/wav'));
    let disposed = false;
    return {
      url,
      dispose() {
        if (!disposed) {
          disposed = true;
          URL.revokeObjectURL(url);
        }
      },
    };
  } catch (error) {
    const code = (error as {code?: string})?.code;
    if (code === 'storage/object-not-found')
      throw new Error('Recording not found. It may have been deleted.');
    if (code === 'storage/unauthorized' || code === 'storage/unauthenticated')
      throw new Error(
        'Recording access denied. Sign in as an admin and retry.'
      );
    throw new Error('Audio could not be downloaded. Please retry.');
  }
}
export async function generateCallReview(
  key: ReviewCallKey,
  regenerate = false
): Promise<ReviewAttempt> {
  return (
    await httpsCallable<ReviewCallKey & {regenerate: boolean}, ReviewAttempt>(
      functions,
      'generateCallReview',
      {timeout: 180000}
    )({...key, regenerate})
  ).data;
}

export async function deleteCall(
  key: ReviewCallKey
): Promise<DeleteCallResult> {
  return (
    await httpsCallable<ReviewCallKey, DeleteCallResult>(
      functions,
      'deleteCall',
      {timeout: 540000}
    )(key)
  ).data;
}
