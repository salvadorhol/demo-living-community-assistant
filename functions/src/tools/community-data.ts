import type {
  CommunityCategory,
  CommunityInformationResponse,
} from '@living-community-assistant/types';

// Canonical demo facts transcribed from assignment.md. Missing facts are not false.
const included = [
  'Basic Cable',
  'Internet/WiFi',
  'Linen Service',
  'Breakfast',
  'Lunch',
  'Dinner',
  'Housekeeping',
];
export const communityCards: Record<
  CommunityCategory,
  CommunityInformationResponse
> = {
  pricing: {
    category: 'pricing',
    facts: {
      currency: 'USD',
      monthlyStartingAt: 2000,
      independentLivingMonthlyStartingAt: 2000,
      assistedLivingMonthlyStartingAt: 3000,
      entranceFee: 3500,
      included,
    },
    notProvided: [
      'Room-specific prices',
      'Second-person fee',
      'Extra service charges',
    ],
  },
  amenities: {
    category: 'amenities',
    facts: {
      amenities: [
        'Elevators',
        'Party space',
        'Exercise pool',
        'Chef-prepared meals with seasonal ingredients',
        'Outdoor seating',
        'Housekeeping services',
        'Beauty salon/services',
        'Gym',
      ],
      services: [
        '24-hour staffing',
        'Bathing assistance',
        'Errand assistance',
        'Medication management',
        'Shopping assistance',
        'Dressing assistance',
        'Eating assistance',
      ],
      cleaning: ['Housekeeping', 'Linen services'],
      activities: [
        'Arts and crafts',
        'Book clubs',
        'Card playing',
        'Cooking classes',
        'Exercise programs',
        'Game nights',
        'Movie nights',
        'Yoga',
      ],
      dietaryOptions: [
        'Diabetic options',
        'Low sugar/salt',
        'Vegetarian',
        'Gluten-free',
      ],
      roomAmenities: [
        'Air conditioning',
        'Microwaves',
        'Private kitchenette',
        'Walk-in shower',
        'Furnished Rooms',
      ],
      religiousServices: ['Devotional areas'],
      dining: [
        'Dining room',
        'In-room dining',
        'Restaurant-style meal service',
      ],
      outdoorActivities: [
        'Accompanied walks',
        'Park visits',
        'Walking trails',
        'Day trips',
      ],
      outdoorAreas: [
        'Courtyard',
        'Garden',
        'Outdoor areas suitable for walking',
      ],
      fitness: ['Gym or fitness room', 'Exercise pool', 'Yoga'],
      included,
    },
    notProvided: [
      'Kosher meals',
      'Individually controlled thermostats',
      'Any unlisted amenity or service',
    ],
  },
  care: {
    category: 'care',
    facts: {
      careTypes: ['Independent Living', 'Assisted Living'],
      skilledNursing: true,
      adultDayCare: false,
      hospice: false,
      respiteCare: true,
      physicalTherapy: 'Onsite, third-party provider',
      privateAidesAllowed: true,
      wheelchairAccessible: true,
      visionImpairedFriendly: true,
    },
    notProvided: [
      'Dementia-specific or memory care',
      'Speech therapy',
      'Individual clinical suitability',
      'Skilled nursing licensing details',
    ],
  },
  payments: {
    category: 'payments',
    facts: {
      participatesIn: ['HUD', 'Medicaid'],
      acceptsLongTermCareInsurance: false,
      veterans: 'Veterans may be eligible for Veterans benefits',
      homeowners: 'Homeowners may be able to use a bridge loan',
    },
    notProvided: [
      'Individual eligibility or coverage',
      'Section 8 participation',
      'Other insurance acceptance',
    ],
  },
  policies: {
    category: 'policies',
    facts: {
      smoking: 'Outdoor smoking areas',
      visiting: [
        'Guests at mealtimes',
        'Flexible visiting hours',
        'On-site parking for guests',
      ],
      security: ['Staff background checks'],
      capacity: 60,
      minimumAge: 60,
      menAndWomenSeparated: false,
      couplesMayLiveTogether: true,
      residentParking: true,
      residentsMayHaveCars: true,
      transportation: [
        'Scheduled local transportation',
        'Transportation to medical appointments',
      ],
      languages: ['English', 'Spanish'],
      leaseTermAsProvided: '12 (unit unspecified)',
      pets: [
        'Cats',
        'Small dogs under 25 lbs.',
        'Service animals',
        'Fish',
        'Small birds',
      ],
    },
    notProvided: [
      'Lease-term units',
      'Second-person fee',
      'Exceptions for large non-service dogs',
    ],
  },
  contact: {
    category: 'contact',
    facts: {
      name: 'ACME Senior Living',
      phone: '850-445-8362',
      address: '145 Fake Stret, Charlotte, NC, 28203',
      salesContact: 'Jami',
      timeZone: 'America/New_York',
      tours: 'Monday–Friday, 09:00–18:00',
    },
    notProvided: [
      'Live call transfer',
      'Keypad voicemail',
      'Brochure or email delivery',
    ],
  },
  careers: {
    category: 'careers',
    facts: {url: 'https://www.talkfurther.com/events-demo'},
    notProvided: ['Current openings', 'Application status'],
  },
};
