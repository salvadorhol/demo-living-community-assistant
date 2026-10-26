export const APPOINTMENTS_PATH = 'appConfig/appointments';
export const APPOINTMENTS_ZONE = 'America/New_York';
export const MAX_APPOINTMENT_SLOTS = 20;
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: APPOINTMENTS_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
function wall(timestamp) {
  const parts = Object.fromEntries(
    formatter.formatToParts(timestamp).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
/** Require exactly one matching instant: reject missing and repeated DST wall times. */
export function appointmentInstant(slot) {
  if (
    !slot ||
    !validDate(slot.date) ||
    typeof slot.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)
  )
    throw new Error(
      'Each slot needs a valid date (YYYY-MM-DD) and time (HH:mm).'
    );
  const target = Date.parse(`${slot.date}T${slot.time}:00Z`);
  const offsets = new Set();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = target + hours * 3600000;
    offsets.add(Date.parse(wall(sample) + 'Z') - sample);
  }
  const matches = [...offsets]
    .map(offset => target - offset)
    .filter(instant => wall(instant) === `${slot.date}T${slot.time}:00`);
  if (matches.length !== 1)
    throw new Error(
      `Slot ${slot.date} ${slot.time} is ambiguous or nonexistent in ${APPOINTMENTS_ZONE}.`
    );
  return new Date(matches[0]);
}
export function validateAppointmentSlots(slots) {
  if (!Array.isArray(slots) || slots.length > MAX_APPOINTMENT_SLOTS)
    throw new Error('Enter a JSON array with at most 20 slots.');
  const seen = new Set();
  for (const slot of slots) {
    if (
      !slot ||
      typeof slot !== 'object' ||
      Object.keys(slot).length !== 2 ||
      !Object.hasOwn(slot, 'date') ||
      !Object.hasOwn(slot, 'time')
    )
      throw new Error('Each slot must contain only date and time.');
    appointmentInstant(slot);
    const id = `${slot.date}T${slot.time}`;
    if (seen.has(id))
      throw new Error(`Duplicate appointment: ${slot.date} ${slot.time}.`);
    seen.add(id);
  }
  return slots;
}
export function availableAppointments(slots, now = new Date()) {
  return {
    timeZone: APPOINTMENTS_ZONE,
    appointments: validateAppointmentSlots(slots)
      .map(slot => ({
        id: `${slot.date}T${slot.time}`,
        date: slot.date,
        startsAt: appointmentInstant(slot).toISOString(),
        localTime: `${slot.date} ${slot.time} ${APPOINTMENTS_ZONE}`,
        durationMinutes: 30,
      }))
      .filter(slot => Date.parse(slot.startsAt) > now.getTime())
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
  };
}
