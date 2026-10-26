import {
  appointmentInstant,
  availableAppointments,
  validateAppointmentSlots,
  validDate,
} from '@living-community-assistant/types/appointments';
it('converts New York wall times across DST without assuming a fixed offset', () => {
  expect(
    appointmentInstant({date: '2026-03-06', time: '09:30'}).toISOString()
  ).toBe('2026-03-06T14:30:00.000Z');
  expect(
    appointmentInstant({date: '2026-03-09', time: '09:30'}).toISOString()
  ).toBe('2026-03-09T13:30:00.000Z');
});
it.each([
  {date: '2026-03-08', time: '02:30'},
  {date: '2026-11-01', time: '01:30'},
  {date: '2026-02-30', time: '10:00'},
  {date: '2026-11-02', time: '24:00'},
])('rejects invalid or ambiguous local slots %j', slot => {
  expect(() => appointmentInstant(slot)).toThrow();
});
it('sorts configured future slots, including weekends, and derives stable identities', () => {
  const slots = [
    {date: '2026-11-01', time: '15:00'},
    {date: '2026-11-01', time: '10:30'},
    {date: '2020-01-01', time: '10:00'},
  ];
  expect(
    availableAppointments(
      slots,
      new Date('2026-11-01T14:00:00Z')
    ).appointments.map(s => s.id)
  ).toEqual(['2026-11-01T10:30', '2026-11-01T15:00']);
  expect(availableAppointments([]).appointments).toEqual([]);
  expect(validDate('2026-02-30')).toBe(false);
});
it.each([
  null,
  {},
  [{date: '2026-11-02', time: '10:00', extra: true}],
  Array(21).fill({date: '2026-11-02', time: '10:00'}),
  [
    {date: '2026-11-02', time: '10:00'},
    {date: '2026-11-02', time: '10:00'},
  ],
])('rejects malformed/duplicate/oversized arrays', value =>
  expect(() => validateAppointmentSlots(value)).toThrow()
);
