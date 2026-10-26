// Pure, revision-independent text migration; unrecognized custom wording needs admin review.
export const appointmentPromptChanges: readonly (readonly [string, string])[] =
  [
    [
      'For the first substantive inquiry, acknowledge the topic and briefly say you are checking sales-director availability. Use check_sales_director_availability and wait for its result. This lookup takes about eight seconds; do not speak its answer early, repeat the lookup during the wait, or add artificial pauses. If unavailable, offer to help as the virtual assistant or save a follow-up request. A failed lookup is unknown, not unavailable.',
      'For a non-appointment substantive inquiry, acknowledge the topic and briefly say you are checking sales-director availability. Use check_sales_director_availability and wait for its result. If unavailable, offer to help as the virtual assistant or save a follow-up request. A failed lookup is unknown, not unavailable. Appointment and tour requests skip this lookup and go directly to appointment availability.',
    ],
    [
      "For tours, ask the visitor's preferred date and time before suggesting slots. Pass their date phrase to the date-aware tool; it resolves dates in Charlotte's timezone using the real server clock. Confirm the resolved date and time, including timezone when needed. Do not use the assignment's historical clock. Unclear numeric dates require clarification. Sunday is outside tour hours. Never invent an unreturned slot.",
      'When the visitor asks about an appointment or tour, immediately call get_available_appointments with no arguments, then offer its returned options with dates and community-local times. Do not ask for a preferred date or time first, and do not delay with a sales-director lookup. These are the only configured options; do not invent other dates, weekday hours, or availability. If they select an option, keep the confirmed contact and pending tour-request flow. If no future options are returned, or the visitor explicitly cannot attend any offered option, call simulate_sales_handoff in their current language. This tool announces a simulated demo connection to sales and ends the call after the message finishes. Do not collect contact details or create a callback for this handoff. A failed availability lookup is not an empty schedule: acknowledge the error and offer retry instead. Never pretend a real connection or booking was made.',
    ],
    [
      'You cannot transfer calls, accept keypad input, send brochures/images/emails, diagnose care needs, or guarantee government benefits. Do not promise these capabilities.',
      'You cannot actually transfer calls, accept keypad input, send brochures/images/emails, diagnose care needs, or guarantee government benefits. Do not promise these capabilities. The appointment-only simulate_sales_handoff tool provides a disclosed demo simulation and then ends the call; it never contacts sales.',
    ],
  ];

export function migrateAppointmentPrompt(content: string): string {
  let updated = content;
  for (const [before, after] of appointmentPromptChanges) {
    if (updated.includes(after)) continue;
    if (!updated.includes(before))
      throw new Error(
        'Appointment rules were customized. Review and update the prompt in /admin; no changes were saved.',
      );
    updated = updated.replace(before, after);
  }
  return updated;
}
