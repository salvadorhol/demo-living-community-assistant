import { createHash, randomUUID } from 'node:crypto';
import type {
  ContactInformationResponse,
  ContactProfile,
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
  let appointmentsChecked = false;
  let closingMessage: string | undefined;
  let turn = 0;
  type Draft = {
    token: string;
    created: number;
    turn: number;
    kind: 'contact' | 'request';
    value: Record<string, unknown>;
  };
  let draft: Draft | undefined;
  const offered = new Map<string, string>();
  const ready = (kind: Draft['kind']) =>
    !!draft &&
    draft.kind === kind &&
    draft.turn < turn &&
    Date.now() - draft.created <= 300_000;
  const prepare = (kind: Draft['kind'], value: Record<string, unknown>) => {
    draft = { token: randomUUID(), created: Date.now(), turn, kind, value };
    return {
      confirmationToken: draft.token,
      valuesToReadBack: value,
      nextStep:
        'Read these values back and wait for the visitor to explicitly confirm in a new turn. Nothing has been saved.',
    };
  };
  const validatedInvoke: Invoke = async (name, args, signal) => {
    try {
      const value = await invoke(name, args, signal);
      if (name === 'getAvailableAppointments') {
        offered.clear();
        appointmentsChecked = false;
        if (isAppointments(value)) {
          appointmentsChecked = true;
          for (const slot of value.appointments)
            offered.set(slot.id, slot.date);
        }
      }
      return value;
    } catch (error) {
      if (name === 'getAvailableAppointments') {
        offered.clear();
        appointmentsChecked = false;
      }
      throw error;
    }
  };
  const extra: ToolDefinition[] = [
    {
      name: 'simulate_sales_handoff',
      description:
        'After a successful appointment lookup, use only when no future slots exist or the visitor explicitly cannot attend any offered option. Simulates sales assistance and ends this demo call after a fixed disclosure. No actual transfer or callback is made. Never use for a failed lookup.',
      enabled: () => appointmentsChecked && !closingMessage,
      write: true,
      parameters: shape({ language: { type: 'string', enum: ['en', 'es'] } }),
      validateArguments: (v: unknown) =>
        object(v) &&
        Object.keys(v).length === 1 &&
        ['en', 'es'].includes(String(v.language)),
      async execute(args) {
        closingMessage =
          args.language === 'es'
            ? 'Para esta demostración, simularé conectarle con nuestro departamento de ventas para recibir ayuda adicional. La llamada finalizará ahora.'
            : 'For this demo, I will simulate connecting you with our sales department for additional assistance. The call will now end.';
        return { simulated: true, endingCall: true };
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
        'Prepare a pending tour or callback request for read-back after collecting a remembered email or phone. Tour slotId must come from the most recent availability lookup. No booking or actual callback is made.',
      parameters: shape(
        {
          kind: { type: 'string', enum: ['tour', 'callback'] },
          slotId: string,
          preferredTime: string,
        },
        ['kind'],
      ),
      validateArguments: (v) =>
        object(v) &&
        Object.keys(v).every((k) =>
          ['kind', 'slotId', 'preferredTime'].includes(k),
        ) &&
        (v.kind === 'tour'
          ? typeof v.slotId === 'string' &&
            offered.has(v.slotId) &&
            v.preferredTime === undefined
          : v.kind === 'callback' &&
            typeof v.preferredTime === 'string' &&
            v.preferredTime.trim().length > 0 &&
            v.preferredTime.length <= 200 &&
            v.slotId === undefined),
      async execute(args) {
        if (!known.profile.email && !known.profile.phone)
          throw new ToolError(
            'CONTACT_REQUIRED',
            draft?.kind === 'contact'
              ? 'Contact details are prepared but not saved. If the visitor has confirmed the read-back in a later turn, call save_contact_information with the existing confirmation token before preparing this request. Otherwise ask them to confirm the prepared details. Do not ask for a different contact method or claim a save failed.'
              : 'No saved email or phone is available. Prepare, confirm, and save a supplied email or phone before preparing this request. No contact write was attempted by this tool.',
          );
        return prepare(
          'request',
          args.kind === 'tour'
            ? {
                kind: 'tour',
                slotId: args.slotId,
                date: offered.get(args.slotId as string),
              }
            : { kind: 'callback', preferredTime: args.preferredTime },
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
          : 'Save the confirmed prepared request as pending staff confirmation. This does not reserve a tour or schedule a callback.',
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
        return result;
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
        ? `Welcome back, ${known.profile.firstName}. This is Sophie, ACME Senior Living's virtual assistant. This conversation is being recorded. How may I help you today?`
        : 'Hi, this is ACME Senior Living. My name is Sophie, your virtual assistant. This conversation is being recorded. How may I help you today?',
    toolChoice: () => 'auto',
    closingMessage: () => closingMessage,
  });
}
