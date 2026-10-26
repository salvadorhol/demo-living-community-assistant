import {httpsCallable} from 'firebase/functions';
import type {
  ReviewCallKey,
  ReviewCallPage,
  ReviewCallDetail,
  ReviewAttempt,
  DeleteCallResult,
} from '@living-community-assistant/types';
import {functions} from './firebase';
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
): Promise<{url: string; expiresAt: number}> {
  return (
    await httpsCallable<ReviewCallKey, {url: string; expiresAt: number}>(
      functions,
      'getReviewAudio'
    )(key)
  ).data;
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
