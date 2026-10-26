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
        'Look up available tour appointment slots. Read-only; does not book or reserve an appointment.',
      valid: isAppointments,
    },
    {
      name: 'get_available_floor_plans',
      functionName: 'getAvailableFloorPlans',
      description:
        'Look up available floor plans and supported room layouts. Room-specific prices, dimensions, and inventory counts are not provided.',
      valid: isFloorPlans,
    },
  ];
  return createToolRegistry(
    [
      ...bindings.map((binding) => ({
        name: binding.name,
        description: binding.description,
        timeoutMs: binding.timeoutMs,
        parameters:
          binding.name === 'get_available_appointments'
            ? {
                type: 'object',
                properties: {
                  date: {
                    type: 'string',
                    description:
                      'Visitor requested date: YYYY-MM-DD, today/tomorrow, hoy/mañana, or next weekday / próximo día. Pass relative phrases to the server to resolve, rather than calculating dates yourself. Ask to clarify ambiguous numeric dates. Charlotte local time.',
                  },
                },
                required: ['date'],
                additionalProperties: false,
              }
            : {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
        validateArguments: (value: unknown) =>
          binding.name === 'get_available_appointments'
            ? object(value) &&
              Object.keys(value).length === 1 &&
              typeof value.date === 'string' &&
              value.date.length <= 40
            : isEmptyArguments(value),
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
