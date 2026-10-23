import { httpsCallable } from 'firebase/functions';
import type { HealthResponse } from '@living-community-assistant/types';
import { functions } from './firebase';

export async function checkHealth(): Promise<HealthResponse> {
  const result = await httpsCallable<void, HealthResponse>(
    functions,
    'healthCallable',
  )();
  return result.data;
}
