import { initializeApp, deleteApp } from 'firebase-admin/app';
import { seedTestAppointments } from '../apps/socket-server/src/testing/seed-appointments.ts';
const app = initializeApp({ projectId: 'demo-living-community-assistant' });
try {
  await seedTestAppointments(app);
} finally {
  await deleteApp(app);
}
