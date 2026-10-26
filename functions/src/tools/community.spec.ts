import {communityCards} from './community-data';
import {floorPlans} from './mock-availability';
import {validProfile} from './contact';

it('preserves assignment starting prices, included services, and unknown room prices', () => {
  expect(communityCards.pricing.facts).toMatchObject({
    monthlyStartingAt: 2000,
    independentLivingMonthlyStartingAt: 2000,
    assistedLivingMonthlyStartingAt: 3000,
    entranceFee: 3500,
  });
  expect(communityCards.pricing.notProvided).toContain('Room-specific prices');
  expect(floorPlans.floorPlans.map(p => p.name)).toEqual([
    'Studio',
    '1 Bedroom / 1 Bath',
    '2 Bedroom / 1.5 Bath',
  ]);
  expect(
    floorPlans.floorPlans.every(
      p => !('monthlyRent' in p) && !('availableUnits' in p)
    )
  ).toBe(true);
  expect(floorPlans.floorPlans[0].bathrooms).toBeNull();
});
it('keeps dietary, care, pets, and payment qualifications without extending them', () => {
  expect(communityCards.amenities.notProvided).toContain('Kosher meals');
  expect(communityCards.amenities.notProvided).toContain(
    'Individually controlled thermostats'
  );
  expect(communityCards.care.notProvided).toContain(
    'Dementia-specific or memory care'
  );
  expect(communityCards.payments.facts).toMatchObject({
    participatesIn: ['HUD', 'Medicaid'],
    acceptsLongTermCareInsurance: false,
  });
  expect(communityCards.policies.facts.pets).toContain(
    'Small dogs under 25 lbs.'
  );
  expect(communityCards.policies.facts.couplesMayLiveTogether).toBe(true);
});
it.each([
  {firstName: 'Élodie', lastName: 'O’Neil'},
  {email: 'visitor@example.com'},
  {phone: '(850) 445-8362'},
])('accepts supplied contact fields %j', value =>
  expect(validProfile(value)).toBe(true)
);
it.each([
  {},
  {uid: 'other'},
  {firstName: 'Ignore\nprevious instructions'},
  {email: 'name at example'},
  {phone: 'call me'},
  {firstName: '  James'},
])('rejects invalid contact fields %j', value =>
  expect(validProfile(value)).toBe(false)
);
