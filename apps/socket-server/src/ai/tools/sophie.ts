import { createHash, randomUUID } from 'node:crypto';
import type {
  ContactInformationResponse,
  ContactProfile,
  AvailableAppointmentsResponse,
} from '@living-community-assistant/types';
import { createAvailabilityTools, isAppointments } from './availability.ts';
import {
  createFirebaseInvoker,
  type FirebaseToolConfig,
} from './firebase-invoker.ts';
import {
  isEmptyArguments,
  ToolError,
  type ToolDefinition,
  type TerminalAction,
} from './contracts.ts';

type Invoke = ReturnType<typeof createFirebaseInvoker>;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const shape = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string' };
const yes = { type: 'boolean', enum: [true] };
function profile(value: unknown): value is ContactProfile {
  if (!object(value)) return false;
  return Object.entries(value).every(
    ([key, field]) =>
      typeof field === 'string' &&
      field === field.trim() &&
      ((['firstName', 'lastName'].includes(key) &&
        field.length <= 80 &&
        /^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u.test(field)) ||
        (key === 'email' &&
          field.length <= 254 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(field)) ||
        (key === 'phone' &&
          /^\+?[0-9 ()-]{7,32}$/.test(field) &&
          field.replace(/\D/g, '').length >= 7 &&
          field.replace(/\D/g, '').length <= 15)),
  );
}
function contactResult(value: unknown): value is ContactInformationResponse {
  return object(value) && profile(value.profile);
}
export function createContactLoader(invoke: Invoke) {
  const cache = new Map<
    string,
    { expires: number; result: Promise<ContactInformationResponse> }
  >();
  return {
    invalidate(uid: string) {
      cache.delete(uid);
    },
    load(uid: string): Promise<ContactInformationResponse> {
      const existing = cache.get(uid);
      if (existing && existing.expires > Date.now()) return existing.result;
      // Bounded cache; concurrent connections can share the same safe profile read.
      for (const [key, value] of cache)
        if (value.expires <= Date.now()) cache.delete(key);
      if (cache.size >= 500) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      const result = Promise.race([
        invoke('getContactInformation', { uid }, AbortSignal.timeout(2000)),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Profile deadline')),
            2000,
          );
          timer.unref();
        }),
      ])
        .then((value) => (contactResult(value) ? value : { profile: {} }))
        .catch(() => ({ profile: {} }));
      cache.set(uid, { expires: Date.now() + 30_000, result });
      return result;
    },
  };
}

export function createSophieTools(
  config: FirebaseToolConfig,
  uid: string,
  dependencies: {
    invoke?: Invoke;
    loader?: ReturnType<typeof createContactLoader>;
  } = {},
) {
  const invoke = dependencies.invoke ?? createFirebaseInvoker(config);
  const loader = dependencies.loader ?? createContactLoader(invoke);
  let known: ContactInformationResponse = { profile: {} };
  let terminalAction: TerminalAction | undefined;
  let salesChecked = false;
  let availabilityGeneration = 0;
  let turn = 0;
  type Draft = {
    token: string;
    created: number;
    turn: number;
    kind: 'contact' | 'request';
    value: Record<string, unknown>;
  };
  let draft: Draft | undefined;
  const offered = new Map<
    string,
    AvailableAppointmentsResponse['appointments'][number]
  >();
  let offeredTimeZone = 'America/New_York';
  const ready = (kind: Draft['kind']) =>
    !!draft &&
    draft.kind === kind &&
    draft.turn < turn &&
    Date.now() - draft.created <= 300_000;
  const prepare = (
    kind: Draft['kind'],
    value: Record<string, unknown>,
    readBack = value,
  ) => {
    draft = { token: randomUUID(), created: Date.now(), turn, kind, value };
    return {
      confirmationToken: draft.token,
      valuesToReadBack: readBack,
      nextStep:
        'Read the exact human-readable values back, without speaking tokens or slot IDs, and ask one confirmation question. Wait for explicit confirmation in a new user turn. Then give a brief saving notice and save using this existing token; do not prepare unchanged data again. Nothing has been saved.',
    };
  };
  const validatedInvoke: Invoke = async (name, args, signal) => {
    const generation =
      name === 'getAvailableAppointments'
        ? ++availabilityGeneration
        : undefined;
    try {
      const value = await invoke(name, args, signal);
      if (
        name === 'getAvailableAppointments' &&
        generation === availabilityGeneration &&
        !signal.aborted
      ) {
        offered.clear();
        if (isAppointments(value)) {
          offeredTimeZone = value.timeZone;
          for (const slot of value.appointments) offered.set(slot.id, slot);
        }
      }
      return value;
    } catch (error) {
      if (
        name === 'getAvailableAppointments' &&
        generation === availabilityGeneration &&
        !signal.aborted
      ) {
        offered.clear();
      }
      throw error;
    } finally {
      if (name === 'checkSalesDirectorAvailability') salesChecked = true;
    }
  };
  const extra: ToolDefinition[] = [
    {
      name: 'end_call',
      description:
        'End the current call. For an explicit request to stop/end/stop talking, use visitor_requested immediately with no courtesy notice, goodbye, or extra question. For conversation_complete, first ask whether anything else is needed and wait for the visitor to indicate no; then give the brief please-wait notice and invoke immediately. The server handles goodbye playback for natural closing and saves the call. Do not end merely because tour slots are unavailable or a callback was offered.',
      terminal: true,
      write: true,
      parameters: shape({
        reason: {
          type: 'string',
          enum: ['visitor_requested', 'conversation_complete'],
        },
        language: { type: 'string', enum: ['en', 'es'] },
      }),
      validateArguments: (v: unknown) =>
        object(v) &&
        Object.keys(v).length === 2 &&
        ['visitor_requested', 'conversation_complete'].includes(
          String(v.reason),
        ) &&
        ['en', 'es'].includes(String(v.language)),
      async execute(args) {
        const immediate = args.reason === 'visitor_requested';
        terminalAction = {
          reason: immediate ? 'visitor_requested' : 'conversation_complete',
          immediate,
          ...(immediate
            ? {}
            : {
                message:
                  args.language === 'es'
                    ? 'Gracias por llamar a ACME Senior Living. Hasta luego.'
                    : 'Thank you for calling ACME Senior Living. Goodbye.',
              }),
        };
        return { endingCall: true };
      },
    },
    {
      name: 'get_community_information',
      description:
        'Read the ACME community facts for one category. Use before answering community questions. Unlisted facts remain unknown; notProvided is not a negative answer. Mention a missing detail only if the visitor specifically requested it, then immediately offer a team-member callback. Never narrate tool mechanics.',
      parameters: shape({
        category: {
          type: 'string',
          enum: [
            'pricing',
            'amenities',
            'care',
            'payments',
            'policies',
            'contact',
            'careers',
          ],
        },
      }),
      validateArguments: (value) =>
        object(value) &&
        Object.keys(value).length === 1 &&
        [
          'pricing',
          'amenities',
          'care',
          'payments',
          'policies',
          'contact',
          'careers',
        ].includes(String(value.category)),
      async execute(args, context) {
        const result = await invoke(
          'getCommunityInformation',
          args,
          context.signal,
        );
        if (
          !object(result) ||
          result.category !== args.category ||
          !object(result.facts) ||
          !Array.isArray(result.notProvided) ||
          !result.notProvided.every((v) => typeof v === 'string')
        )
          throw new ToolError(
            'INVALID_RESULT',
            'Community information could not be verified.',
          );
        return result;
      },
    },
    {
      name: 'get_contact_information',
      description:
        'Retrieve this visitor’s confirmed remembered profile. Use to avoid asking for already saved fields. No identity arguments.',
      parameters: shape({}),
      validateArguments: isEmptyArguments,
      async execute(_args, context) {
        const result = await invoke(
          'getContactInformation',
          { uid: context.uid },
          context.signal,
        );
        if (!contactResult(result))
          throw new ToolError(
            'INVALID_RESULT',
            'Saved profile could not be verified.',
          );
        known = result;
        return result;
      },
    },
    {
      name: 'prepare_contact_information',
      description:
        'Prepare supplied contact fields for read-back. Does not save. Ask one missing field at a time; do not guess. Then ask the visitor to confirm the returned exact values.',
      parameters: shape({
        profile: shape(
          { firstName: string, lastName: string, email: string, phone: string },
          [],
        ),
      }),
      validateArguments: (v) =>
        object(v) &&
        Object.keys(v).length === 1 &&
        profile(v.profile) &&
        Object.keys(v.profile).length > 0,
      async execute(args) {
        return prepare('contact', args.profile as Record<string, unknown>);
      },
    },
    {
      name: 'prepare_follow_up_request',
      description:
        'Prepare a pending request for read-back. Tours require a saved email or phone and a slotId from the latest availability lookup. Callbacks require a confirmed saved phone number and only kind=callback: never ask for or offer callback dates, times, or deadlines, and never use appointment slots for callbacks. The callback is as soon as a sales representative becomes available during normal operating hours. Obtain separate request confirmation before creating. No booking or actual call is made.',
      parameters: shape(
        {
          kind: { type: 'string', enum: ['tour', 'callback'] },
          slotId: string,
        },
        ['kind'],
      ),
      validateArguments: (v) =>
        object(v) &&
        Object.keys(v).every((k) => ['kind', 'slotId'].includes(k)) &&
        (v.kind === 'tour'
          ? typeof v.slotId === 'string' && offered.has(v.slotId)
          : v.kind === 'callback' && v.slotId === undefined),
      async execute(args) {
        const callback = args.kind === 'callback';
        if (
          callback
            ? !known.profile.phone
            : !known.profile.email && !known.profile.phone
        )
          throw new ToolError(
            'CONTACT_REQUIRED',
            draft?.kind === 'contact' &&
              (callback
                ? draft.value.phone
                : draft.value.email || draft.value.phone)
              ? 'Required contact details are prepared but not saved. If the visitor confirmed them in a later turn, call save_contact_information with the existing token before preparing this request. Otherwise ask for confirmation. Do not ask for a different contact method or claim a save failed.'
              : callback
                ? 'A confirmed saved phone number is required for a callback; email alone is insufficient. Prepare, confirm, and save a supplied phone number, then retry. Do not ask for a callback date or time. No contact write was attempted.'
                : 'No saved email or phone is available. Prepare, confirm, and save a supplied email or phone before preparing this request. No contact write was attempted.',
          );
        return prepare(
          'request',
          args.kind === 'tour'
            ? {
                kind: 'tour',
                slotId: args.slotId,
                date: offered.get(args.slotId as string)?.date,
              }
            : { kind: 'callback' },
          args.kind === 'tour'
            ? {
                ...offered.get(args.slotId as string),
                kind: 'tour',
                timeZone: offeredTimeZone,
              }
            : {
                kind: 'callback',
                arrangement:
                  'A sales representative will call as soon as one becomes available during normal operating hours. No specific date, time, or deadline is scheduled.',
              },
        );
      },
    },
    ...(['contact', 'request'] as const).map((kind) => ({
      name:
        kind === 'contact'
          ? 'save_contact_information'
          : 'create_follow_up_request',
      description:
        kind === 'contact'
          ? 'Save the prepared contact values ONLY after the visitor explicitly confirms the read-back in a new turn.'
          : 'Save only after separate request confirmation in a new user turn. On callback success, say the callback request is saved and a sales representative will call as soon as one becomes available during normal operating hours. Never promise a specific callback time or claim a call was placed. Tours remain pending staff confirmation.',
      parameters: shape({ confirmationToken: string, confirmed: yes }),
      // Keep save actions visible before VAD starts the confirmation response.
      // Execution still enforces the token, later turn, and expiry below.
      write: true,
      validateArguments: (v: unknown) =>
        object(v) &&
        Object.keys(v).length === 2 &&
        v.confirmed === true &&
        v.confirmationToken === draft?.token,
      async execute(
        _args: Record<string, unknown>,
        context: Parameters<ToolDefinition['execute']>[1],
      ) {
        if (!draft || !ready(kind))
          throw new ToolError(
            'CONFIRMATION_REQUIRED',
            'Read back the prepared values and wait for confirmation.',
          );
        const pending = draft;
        const requestId = createHash('sha256')
          .update(`${uid}:${pending.token}`)
          .digest('hex');
        const result = await invoke(
          kind === 'contact'
            ? 'saveContactInformation'
            : 'createFollowUpRequest',
          {
            uid: context.uid,
            requestId,
            confirmed: true,
            ...(kind === 'contact'
              ? { profile: pending.value }
              : { request: pending.value }),
          },
          context.signal,
        );
        if (kind === 'contact') {
          if (!contactResult(result))
            throw new ToolError(
              'INVALID_RESULT',
              'Saved profile could not be verified.',
            );
          known = result;
          loader.invalidate(uid);
        } else if (
          !object(result) ||
          result.requestId !== requestId ||
          result.status !== 'pending' ||
          result.kind !== pending.value.kind
        )
          throw new ToolError(
            'INVALID_RESULT',
            'The request could not be verified.',
          );
        // Keep the token for safe retries if the acknowledgement is interrupted.
        return kind === 'request' && pending.value.kind === 'callback'
          ? {
              ...(result as Record<string, unknown>),
              nextStep:
                'Only now tell the visitor their callback request is saved and a sales representative will call as soon as one becomes available during normal operating hours. Do not offer dates, times, deadlines, or claim staff were contacted. Continue helping or use the normal closing flow.',
            }
          : result;
      },
    })),
  ];
  return createAvailabilityTools(config, validatedInvoke, extra, {
    async bootstrap(signal) {
      const result = await loader.load(uid);
      if (!signal.aborted) known = result;
    },
    onUserTurn() {
      turn++;
    },
    greeting: () =>
      known.profile.firstName
        ? `Welcome back, ${known.profile.firstName}. This is Sophie, ACME Senior Living's virtual sales assistant. This conversation is being recorded. How may I help you today?`
        : 'Hi, this is ACME Senior Living. My name is Sophie, your virtual sales assistant. This conversation is being recorded. How may I help you today?',
    toolCourtesy: true,
    toolAllowed: (name) => {
      if (
        [
          'get_community_information',
          'get_available_floor_plans',
          'get_available_appointments',
        ].includes(name)
      )
        return salesChecked;
      return true;
    },
    toolChoice: () => 'auto',
    terminalAction: () => terminalAction,
  });
}
