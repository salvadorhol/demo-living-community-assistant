import {onCall, onRequest} from 'firebase-functions/v2/https';
import type {HealthResponse} from '@living-community-assistant/types';
export const health = onRequest(
  {region: 'us-central1', cors: true, maxInstances: 2},
  (_request, response) => {
    const body: HealthResponse = {
      status: 'ok',
      time: new Date().getTime(),
    };
    response.status(200).json(body);
  }
);

export const healthCallable = onCall(
  {region: 'us-central1', maxInstances: 2},
  (): HealthResponse => ({status: 'ok', time: new Date().getTime()})
);

export {
  getAvailableAppointments,
  getAvailableFloorPlans,
  checkSalesDirectorAvailability,
  getCommunityInformation,
} from './tools/availability';
export {
  getContactInformation,
  saveContactInformation,
  createFollowUpRequest,
} from './tools/contact';

export {unlockApp} from './access';
