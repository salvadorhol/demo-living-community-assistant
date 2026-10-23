declare module '#firebase-environment' {
  import type { FirebaseClientEnvironment } from './environments/environment.types';
  const environment: FirebaseClientEnvironment;
  export default environment;
}

declare const __FIREBASE_USE_EMULATOR__: boolean;
