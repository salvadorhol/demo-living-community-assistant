import type {
  AvailableAppointmentsResponse,
  AvailableFloorPlansResponse,
  SalesDirectorAvailabilityResponse,
} from '@living-community-assistant/types';

export const salesDirectorAvailability: SalesDirectorAvailabilityResponse = {
  mock: true,
  available: false,
};

export const appointments: AvailableAppointmentsResponse = {
  mock: true,
  timeZone: 'America/Detroit',
  appointments: [
    {
      id: 'tour-1',
      startsAt: '2026-11-02T10:00:00-05:00',
      durationMinutes: 30,
    },
    {
      id: 'tour-2',
      startsAt: '2026-11-03T14:00:00-05:00',
      durationMinutes: 30,
    },
  ],
};
export const floorPlans: AvailableFloorPlansResponse = {
  mock: true,
  currency: 'USD',
  floorPlans: [
    {
      id: 'fire',
      name: 'Fire',
      bedrooms: 4,
      bathrooms: 2,
      squareFeet: 1500,
      monthlyRent: 2500,
      availableUnits: 1,
    },
    {
      id: 'maple',
      name: 'Maple',
      bedrooms: 1,
      bathrooms: 1,
      squareFeet: 750,
      monthlyRent: 1500,
      availableUnits: 2,
    },
    {
      id: 'oak',
      name: 'Oak',
      bedrooms: 2,
      bathrooms: 2,
      squareFeet: 1100,
      monthlyRent: 2100,
      availableUnits: 3,
    },
  ],
};
