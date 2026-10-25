import {setTimeout as delay} from 'node:timers/promises';
import {onRequest} from 'firebase-functions/v2/https';
import type {Request, Response} from 'express';
import {appointments, floorPlans} from './mock-availability';

const options = {
  region: 'us-central1',
  invoker: 'private',
  cors: false,
  maxInstances: 2,
  timeoutSeconds: 10,
} as const;
const MOCK_RESPONSE_DELAY_MS = 1500;

async function respond(
  request: Request,
  response: Response,
  value: unknown
): Promise<void> {
  response.set('Cache-Control', 'private, no-store');
  if (request.method !== 'POST') {
    response
      .set('Allow', 'POST')
      .status(405)
      .json({
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Use POST with an empty JSON object.',
        },
      });
    return;
  }
  const body: unknown = request.body;
  if (
    !request.is('application/json') ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).length !== 0
  ) {
    response.status(400).json({
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'Expected an empty JSON object.',
      },
    });
    return;
  }

  await delay(MOCK_RESPONSE_DELAY_MS);
  response.status(200).json(value);
}
export const getAvailableAppointments = onRequest(
  options,
  (request, response) => respond(request, response, appointments)
);
export const getAvailableFloorPlans = onRequest(options, (request, response) =>
  respond(request, response, floorPlans)
);
