import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const environmentDirectory = 'apps/living-community-assistant/src/environments';

export function selectWebEnvironment({ root, command, mode }) {
  const kind =
    mode === 'test'
      ? 'example'
      : mode === 'local-emulator' && command === 'serve'
        ? 'local'
        : 'prod';
  const path = resolve(root, environmentDirectory, `environment.${kind}.ts`);
  if (kind === 'local' && !existsSync(path)) {
    return {
      kind,
      path: resolve(root, environmentDirectory, 'environment.example.ts'),
    };
  }
  if (kind === 'prod' && !existsSync(path) && command === 'build') {
    return {
      kind: 'example',
      path: resolve(root, environmentDirectory, 'environment.example.ts'),
    };
  }
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path}. Copy environment.example.ts to environment.${kind}.ts and fill in the Firebase Web SDK properties.`,
    );
  }
  return { kind, path };
}

export async function readProductionWebEnvironment(root) {
  const { path } = selectWebEnvironment({
    root,
    command: 'build',
    mode: 'production',
  });
  const { default: environment } = await import(pathToFileURL(path).href);
  return environment;
}
