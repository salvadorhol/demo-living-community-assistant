import type {
  AvailableFloorPlansResponse,
  SalesDirectorAvailabilityResponse,
} from '@living-community-assistant/types';
export const salesDirectorAvailability: SalesDirectorAvailabilityResponse = {
  available: false,
};
export const floorPlans: AvailableFloorPlansResponse = {
  floorPlans: [
    {
      id: 'studio',
      name: 'Studio',
      bedrooms: 0,
      bathrooms: null,
      available: true,
    },
    {
      id: 'one-bedroom',
      name: '1 Bedroom / 1 Bath',
      bedrooms: 1,
      bathrooms: 1,
      available: true,
    },
    {
      id: 'two-bedroom',
      name: '2 Bedroom / 1.5 Bath',
      bedrooms: 2,
      bathrooms: 1.5,
      available: true,
    },
  ],
  unknown: [
    'Studio bathroom count',
    'Square footage',
    'Room-specific pricing',
    'Unit counts',
  ],
};
