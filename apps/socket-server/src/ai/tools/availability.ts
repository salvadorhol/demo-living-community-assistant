import type {
  AvailableAppointmentsResponse,
  AvailableFloorPlansResponse,
} from '@living-community-assistant/types';
import {
  createFirebaseInvoker,
  type FirebaseToolConfig,
} from './firebase-invoker.ts';
import { isEmptyArguments, ToolError } from './contracts.ts';
import { createToolRegistry } from './registry.ts';

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function isAppointments(
  value: unknown,
): value is AvailableAppointmentsResponse {
  return (
    object(value) &&
    value.mock === true &&
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
    value.mock === true &&
    value.currency === 'USD' &&
    Array.isArray(value.floorPlans) &&
    value.floorPlans.every(
      (item) =>
        object(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        [
          'bedrooms',
          'bathrooms',
          'squareFeet',
          'monthlyRent',
          'availableUnits',
        ].every((field) => nonnegative(item[field])),
    )
  );
}
/** Add trusted function bindings here; the model never supplies an endpoint. */
export function createAvailabilityTools(
  config: FirebaseToolConfig,
  invoke = createFirebaseInvoker(config),
) {
  const bindings = [
    {
      name: 'get_available_appointments',
      functionName: 'getAvailableAppointments',
      description:
        'Look up mock available tour appointment slots. Read-only; does not book or reserve an appointment.',
      valid: isAppointments,
    },
    {
      name: 'get_available_floor_plans',
      functionName: 'getAvailableFloorPlans',
      description:
        'Look up mock available floor plans, bedrooms, square footage, monthly rent and available units. These are sample values, not live availability.',
      valid: isFloorPlans,
    },
  ];
  return createToolRegistry(
    bindings.map((binding) => ({
      name: binding.name,
      description: binding.description,
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      validateArguments: isEmptyArguments,
      async execute(args, context) {
        const result = await invoke(binding.functionName, args, context.signal);
        if (!binding.valid(result))
          throw new ToolError(
            'INVALID_RESULT',
            'Availability service returned an invalid result.',
          );
        return result;
      },
    })),
  );
}
