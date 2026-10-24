import type { FirebaseOptions } from 'firebase/app';

export interface FirebaseClientEnvironment {
  socketUrl: string;
  firebase: FirebaseOptions & {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}
