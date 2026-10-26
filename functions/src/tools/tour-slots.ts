import type {AvailableAppointmentsResponse} from '@living-community-assistant/types';

export const TOUR_ZONE = 'America/New_York';
export function localDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TOUR_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const field = (key: string) => {
    const part = parts.find(p => p.type === key);
    if (!part) throw new Error('Missing timezone component');
    return part.value;
  };
  return `${field('year')}-${field('month')}-${field('day')}`;
}
export function validDate(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
// Resolve a local wall-clock time using the IANA zone; never assume a fixed DST offset.
export function tourInstant(date: string, hour: number): Date {
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: TOUR_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(timestamp);
    const get = (key: string) => {
      const part = p.find(v => v.type === key);
      if (!part) throw new Error('Missing timezone component');
      return part.value;
    };
    const wall = Date.parse(
      `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`
    );
    timestamp += target - wall;
  }
  return new Date(timestamp);
}
export function tourSlots(
  date: string,
  now = new Date()
): AvailableAppointmentsResponse {
  const appointments: AvailableAppointmentsResponse['appointments'] = [];
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day >= 1 && day <= 5) {
    for (let hour = 9; hour <= 17; hour++) {
      const start = tourInstant(date, hour);
      if (start > now)
        appointments.push({
          id: `${date}-${hour}`,
          startsAt: start.toISOString(),
          localTime: `${date} ${String(hour).padStart(2, '0')}:00 ${TOUR_ZONE}`,
          durationMinutes: 30,
        });
    }
  }
  return {timeZone: TOUR_ZONE, appointments};
}

export function resolveTourDate(
  value: string,
  now = new Date()
): string | undefined {
  if (validDate(value)) return value;
  let text = value.toLowerCase().trim();
  const spanish: Record<string, string> = {
    hoy: 'today',
    mañana: 'tomorrow',
    domingo: 'sunday',
    lunes: 'monday',
    martes: 'tuesday',
    miércoles: 'wednesday',
    jueves: 'thursday',
    viernes: 'friday',
    sábado: 'saturday',
  };
  text = text.replace(/^(el )?(próximo|proximo|siguiente) /, 'next ');
  text = text.replace(/\S+$/, word => spanish[word] ?? word);
  const today = localDate(now);
  const base = new Date(`${today}T12:00:00Z`);
  let days: number;
  if (text === 'today') days = 0;
  else if (text === 'tomorrow') days = 1;
  else {
    const match =
      /^(next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(
        text
      );
    if (!match) return undefined;
    const wanted = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ].indexOf(match[2]);
    days = (wanted - base.getUTCDay() + 7) % 7;
    if (days === 0) days = 7;
  }
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
