import type {AvailableAppointmentsResponse} from './src/index';
export interface AppointmentSlot {
  date: string;
  time: string;
}
export interface AppointmentsConfig {
  slots: AppointmentSlot[];
  revision: number;
  updatedAt: {toMillis(): number};
  updatedBy: string;
}
export const APPOINTMENTS_PATH: 'appConfig/appointments';
export const APPOINTMENTS_ZONE: 'America/New_York';
export const MAX_APPOINTMENT_SLOTS: 20;
export function validDate(value: unknown): value is string;
export function appointmentInstant(slot: AppointmentSlot): Date;
export function validateAppointmentSlots(slots: unknown): AppointmentSlot[];
export function availableAppointments(
  slots: unknown,
  now?: Date
): AvailableAppointmentsResponse;
