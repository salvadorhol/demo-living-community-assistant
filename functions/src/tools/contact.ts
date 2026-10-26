import {getApps, initializeApp} from 'firebase-admin/app';
import {getFirestore, FieldValue} from 'firebase-admin/firestore';
import {createHash} from 'node:crypto';
import {onRequest} from 'firebase-functions/v2/https';
import type {Request, Response} from 'express';
import type {ContactProfile} from '@living-community-assistant/types';
import {invalid, object, privateToolOptions, toolRequest} from './availability';
import {
  APPOINTMENTS_PATH,
  availableAppointments,
  validDate,
} from '@living-community-assistant/types/appointments';

export function validProfile(value: unknown): value is ContactProfile {
  if (!object(value) || !Object.keys(value).length) return false;
  return Object.entries(value).every(([key, field]) => {
    if (typeof field !== 'string' || field !== field.trim()) return false;
    if (key === 'firstName' || key === 'lastName')
      return (
        field.length <= 80 && /^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u.test(field)
      );
    if (key === 'email')
      return field.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(field);
    if (key === 'phone')
      return (
        /^\+?[0-9 ()-]{7,32}$/.test(field) &&
        field.replace(/\D/g, '').length >= 7 &&
        field.replace(/\D/g, '').length <= 15
      );
    return false;
  });
}
const db = () => getFirestore(getApps()[0] ?? initializeApp());
// These endpoints are IAM-private. Only the trusted socket backend supplies uid;
// it is never exposed in the model tool schema or accepted from browser tools.
function envelope(
  request: Request,
  response: Response,
  keys: string[]
): (Record<string, unknown> & {uid: string}) | undefined {
  const body = toolRequest(request, response);
  if (!body) return undefined;
  if (
    typeof body.uid !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.uid) ||
    Object.keys(body).some(k => !keys.includes(k))
  ) {
    invalid(response);
    return undefined;
  }
  return {...body, uid: body.uid};
}
export const getContactInformation = onRequest(
  privateToolOptions,
  async (request, response) => {
    const body = envelope(request, response, ['uid']);
    if (!body) return;
    try {
      const snapshot = await db().doc(`sessions/${body.uid}`).get();
      const contact = snapshot.get('contact');
      response.json({
        profile: validProfile(contact?.profile) ? contact.profile : {},
      });
    } catch {
      response.status(503).json({error: {code: 'STORE_UNAVAILABLE'}});
    }
  }
);

async function write(
  request: Request,
  response: Response,
  kind: 'contact' | 'request'
): Promise<void> {
  const body = envelope(request, response, [
    'uid',
    'requestId',
    'confirmed',
    'profile',
    'request',
  ]);
  if (!body) return;
  if (
    body.confirmed !== true ||
    typeof body.requestId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.requestId)
  ) {
    invalid(response);
    return;
  }
  if (
    kind === 'contact' &&
    (!validProfile(body.profile) || body.request !== undefined)
  ) {
    invalid(response);
    return;
  }
  const wanted = body.request;
  if (kind === 'request') {
    if (
      body.profile !== undefined ||
      !object(wanted) ||
      !['tour', 'callback'].includes(String(wanted.kind)) ||
      Object.keys(wanted).some(
        k => !['kind', 'slotId', 'date', 'preferredTime'].includes(k)
      )
    ) {
      invalid(response);
      return;
    }
    if (wanted.kind === 'tour') {
      if (
        !validDate(wanted.date) ||
        typeof wanted.slotId !== 'string' ||
        wanted.preferredTime !== undefined
      ) {
        invalid(response);
        return;
      }
    } else if (
      typeof wanted.preferredTime !== 'string' ||
      !wanted.preferredTime.trim() ||
      wanted.preferredTime.length > 200 ||
      wanted.slotId !== undefined ||
      wanted.date !== undefined
    ) {
      invalid(response);
      return;
    }
  }
  const requestId = body.requestId;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({kind, profile: body.profile, request: wanted}))
    .digest('hex');
  const database = db();
  const session = database.doc(`sessions/${body.uid}`);
  const receipt = session.collection('toolWrites').doc(requestId);
  try {
    const result = await database.runTransaction(async transaction => {
      const previous = await transaction.get(receipt);
      if (previous.exists) {
        if (previous.get('fingerprint') !== fingerprint)
          throw new Error('CONFLICT');
        const saved = previous.get('result');
        return kind === 'contact' ? {profile: saved.profile} : saved;
      }
      let result: unknown;
      if (kind === 'contact') {
        const current = await transaction.get(session);
        const profile = {
          ...(current.get('contact.profile') ?? {}),
          ...(body.profile as ContactProfile),
        };
        result = {profile};
        transaction.set(
          session,
          {
            contact: {
              profile,
              updatedAt: FieldValue.serverTimestamp(),
            },
          },
          {merge: true}
        );
      } else {
        const current = await transaction.get(session);
        if (
          !validProfile(current.get('contact.profile')) ||
          (!current.get('contact.profile.email') &&
            !current.get('contact.profile.phone'))
        )
          throw new Error('CONTACT_REQUIRED');
        if (
          object(wanted) &&
          wanted.kind === 'tour' &&
          !availableAppointments(
            (await transaction.get(database.doc(APPOINTMENTS_PATH))).get(
              'slots'
            )
          ).appointments.some(
            slot => slot.id === wanted.slotId && slot.date === wanted.date
          )
        )
          throw new Error('SLOT_UNAVAILABLE');
        result = {
          requestId,
          kind: (wanted as Record<string, unknown>).kind,
          status: 'pending',
        };
        transaction.set(session.collection('followUpRequests').doc(requestId), {
          ...(wanted as object),
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      transaction.set(receipt, {
        fingerprint,
        result,
        createdAt: FieldValue.serverTimestamp(),
      });
      return result;
    });
    response.json(result);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['CONFLICT', 'SLOT_UNAVAILABLE', 'CONTACT_REQUIRED'].includes(code))
      response.status(409).json({error: {code}});
    else response.status(503).json({error: {code: 'STORE_UNAVAILABLE'}});
  }
}
export const saveContactInformation = onRequest(
  privateToolOptions,
  (req, res) => write(req, res, 'contact')
);
export const createFollowUpRequest = onRequest(privateToolOptions, (req, res) =>
  write(req, res, 'request')
);
