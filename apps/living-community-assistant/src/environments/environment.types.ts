import type { FirebaseOptions } from 'firebase/app';

export interface FirebaseClientEnvironment {
  socketUrl: string;
  emulators?: {
    auth: number;
    firestore: number;
    functions: number;
    storage: number;
  };
  firebase: FirebaseOptions & {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}
