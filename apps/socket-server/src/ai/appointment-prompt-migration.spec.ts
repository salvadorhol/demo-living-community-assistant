import {
  appointmentPromptChanges,
  migrateAppointmentPrompt,
} from './appointment-prompt-migration.ts';
it('preserves custom content and migrates old policies once', () => {
  const before =
    'My custom prefix\n' +
    appointmentPromptChanges.map(([old]) => old).join('\n') +
    '\nMy custom footer';
  const after = migrateAppointmentPrompt(before);
  expect(after).toContain('My custom prefix');
  expect(after).toContain('My custom footer');
  expect(after).toContain('simulate_sales_handoff');
  expect(migrateAppointmentPrompt(after)).toBe(after);
});
it('stops instead of overwriting unknown customized rules', () =>
  expect(() => migrateAppointmentPrompt('Custom appointment policy')).toThrow(
    'customized',
  ));
