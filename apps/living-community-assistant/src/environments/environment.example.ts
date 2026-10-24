import type { FirebaseClientEnvironment } from './environment.types';

// Copy to environment.local.ts for emulator development. For production,
// copy to environment.prod.ts and replace every value with your Web app config.
export default {
  emulators: { auth: 9099, firestore: 8080, functions: 5001, storage: 9199 },
  socketUrl: 'http://127.0.0.1:3000',
  firebase: {
    apiKey: 'demo-api-key',
    storageBucket: 'demo-living-community-assistant.firebasestorage.app',
    authDomain: 'demo-living-community-assistant.firebaseapp.com',
    projectId: 'demo-living-community-assistant',
    appId: '1:1234567890:web:demo',
  },
} satisfies FirebaseClientEnvironment;
