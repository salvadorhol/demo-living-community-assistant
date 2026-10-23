import type { FirebaseOptions } from 'firebase/app';

export interface FirebaseClientEnvironment {
  firebase: FirebaseOptions & {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}
