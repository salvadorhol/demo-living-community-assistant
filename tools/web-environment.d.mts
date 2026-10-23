export interface WebEnvironmentSelection {
  kind: 'example' | 'local' | 'prod';
  path: string;
}

export function selectWebEnvironment(options: {
  root: string;
  command: 'build' | 'serve';
  mode: string;
}): WebEnvironmentSelection;

export function readProductionWebEnvironment(root: string): Promise<{
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}>;
