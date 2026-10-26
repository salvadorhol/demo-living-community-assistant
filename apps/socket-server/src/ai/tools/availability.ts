import type {
  AvailableAppointmentsResponse,
  AvailableFloorPlansResponse,
  SalesDirectorAvailabilityResponse,
} from '@living-community-assistant/types';
import {
  createFirebaseInvoker,
  type FirebaseToolConfig,
} from './firebase-invoker.ts';
import { isEmptyArguments, ToolError } from './contracts.ts';
import type { ToolDefinition } from './contracts.ts';
import { createToolRegistry } from './registry.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function isSalesDirectorAvailability(
  value: unknown,
): value is SalesDirectorAvailabilityResponse {
  return object(value) && typeof value.available === 'boolean';
}
export function isAppointments(
  value: unknown,
): value is AvailableAppointmentsResponse {
  return (
    object(value) &&
    typeof value.timeZone === 'string' &&
    Array.isArray(value.appointments) &&
    value.appointments.every(
      (item) =>
        object(item) &&
        typeof item.id === 'string' &&
        typeof item.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(item.date) &&
        typeof item.startsAt === 'string' &&
        Number.isFinite(Date.parse(item.startsAt)) &&
        nonnegative(item.durationMinutes) &&
        item.durationMinutes > 0,
    )
  );
}
export function isFloorPlans(
  value: unknown,
): value is AvailableFloorPlansResponse {
  return (
    object(value) &&
    Array.isArray(value.unknown) &&
    value.unknown.every((field) => typeof field === 'string') &&
    Array.isArray(value.floorPlans) &&
    value.floorPlans.every(
      (item) =>
        object(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        nonnegative(item.bedrooms) &&
        (item.bathrooms === null || nonnegative(item.bathrooms)) &&
        item.available === true,
    )
  );
}
/** Add trusted function bindings here; the model never supplies an endpoint. */
export function createAvailabilityTools(
  config: FirebaseToolConfig,
  invoke = createFirebaseInvoker(config),
  additional: readonly ToolDefinition[] = [],
  lifecycle: Parameters<typeof createToolRegistry>[1] = {},
) {
  const bindings = [
    {
      name: 'check_sales_director_availability',
      functionName: 'checkSalesDirectorAvailability',
      description:
        'Check sales director availability. Read-only lookup; does not contact anyone or transfer the call.',
      valid: isSalesDirectorAvailability,
      timeoutMs: 20_000,
    },
    {
      name: 'get_available_appointments',
      functionName: 'getAvailableAppointments',
      description:
        'After the initial sales-director attempt, immediately retrieve all configured tour appointment options when asked about appointments or tours. No date or preference question is needed first. Present only returned options. An empty array means no tour appointments: offer an optional callback as soon as a sales representative is available during normal operating hours; do not end the call or invent another date. If all options are unsuitable, offer that same callback. Never use this tool to schedule a callback. Read-only; does not book or reserve an appointment.',
      valid: isAppointments,
    },
    {
      name: 'get_available_floor_plans',
      functionName: 'getAvailableFloorPlans',
      description:
        'Look up available floor plans and supported room layouts. Keep unknown fields internal unless the visitor specifically asks for that detail; then acknowledge the gap and offer a team-member callback. Do not invent room-specific prices, dimensions, or inventory counts.',
      valid: isFloorPlans,
    },
  ];
  return createToolRegistry(
    [
      ...bindings.map((binding) => ({
        name: binding.name,
        description: binding.description,
        timeoutMs: binding.timeoutMs,
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        validateArguments: isEmptyArguments,
        async execute(
          args: Record<string, unknown>,
          context: Parameters<ToolDefinition['execute']>[1],
        ) {
          const result = await invoke(
            binding.functionName,
            args,
            context.signal,
          );
          if (!binding.valid(result))
            throw new ToolError(
              'INVALID_RESULT',
              'Availability service returned an invalid result.',
            );
          return result;
        },
      })),
      ...additional,
    ],
    lifecycle,
  );
}
