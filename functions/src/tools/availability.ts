import {setTimeout as delay} from 'node:timers/promises';
import {onRequest} from 'firebase-functions/v2/https';
import type {Request, Response} from 'express';
import {floorPlans, salesDirectorAvailability} from './mock-availability';
import {communityCards} from './community-data';
import {resolveTourDate, tourSlots} from './tour-slots';

export const privateToolOptions = {
  region: 'us-central1',
  invoker: 'private',
  cors: false,
  maxInstances: 2,
  timeoutSeconds: 10,
} as const;
export const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
export function toolRequest(
  request: Request,
  response: Response
): Record<string, unknown> | undefined {
  response.set('Cache-Control', 'private, no-store');
  if (request.method !== 'POST') {
    response
      .set('Allow', 'POST')
      .status(405)
      .json({
        error: {code: 'METHOD_NOT_ALLOWED', message: 'Use POST with JSON.'},
      });
    return undefined;
  }
  if (!request.is('application/json') || !object(request.body)) {
    invalid(response);
    return undefined;
  }
  return request.body;
}
export function invalid(response: Response): void {
  response
    .status(400)
    .json({
      error: {code: 'INVALID_ARGUMENT', message: 'Invalid tool arguments.'},
    });
}
async function empty(
  request: Request,
  response: Response,
  value: unknown,
  ms = 1500
): Promise<void> {
  const body = toolRequest(request, response);
  if (!body) return;
  if (Object.keys(body).length) {
    invalid(response);
    return;
  }
  await delay(ms);
  response.status(200).json(value);
}
export const getAvailableAppointments = onRequest(
  privateToolOptions,
  async (request, response) => {
    const body = toolRequest(request, response);
    if (!body) return;
    const date =
      typeof body.date === 'string' ? resolveTourDate(body.date) : undefined;
    if (Object.keys(body).some(k => k !== 'date') || !date) {
      invalid(response);
      return;
    }
    await delay(1500);
    response.json({
      ...tourSlots(date),
      requestedDate: date,
      currentTime: new Date().toISOString(),
    });
  }
);
export const getAvailableFloorPlans = onRequest(
  privateToolOptions,
  (req, res) => empty(req, res, floorPlans)
);
export const checkSalesDirectorAvailability = onRequest(
  {...privateToolOptions, timeoutSeconds: 20},
  (req, res) => empty(req, res, salesDirectorAvailability, 8000)
);
export const getCommunityInformation = onRequest(
  privateToolOptions,
  (request, response) => {
    const body = toolRequest(request, response);
    if (!body) return;
    if (
      Object.keys(body).length !== 1 ||
      typeof body.category !== 'string' ||
      !Object.hasOwn(communityCards, body.category)
    ) {
      invalid(response);
      return;
    }
    response.json(communityCards[body.category as keyof typeof communityCards]);
  }
);
