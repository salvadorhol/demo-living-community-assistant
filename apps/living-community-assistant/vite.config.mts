/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nxReadySignal } from '@nx/vite/plugins/nx-ready-signal.plugin';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { selectWebEnvironment } from '../../tools/web-environment.mjs';

export default defineConfig(async ({ command, mode }) => {
  const root = resolve(import.meta.dirname, '../..');
  const selected = selectWebEnvironment({ root, command, mode });
  const { default: environment } = await import(
    pathToFileURL(selected.path).href
  );
  for (const key of ['apiKey', 'authDomain', 'projectId', 'appId'] as const) {
    if (
      typeof environment?.firebase?.[key] !== 'string' ||
      !environment.firebase[key].trim()
    ) {
      throw new Error(`${selected.path} must define firebase.${key}.`);
    }
  }
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/apps/living-community-assistant',
    define: {
      __FIREBASE_USE_EMULATOR__: selected.kind === 'local',
    },
    resolve: {
      alias: {
        '#firebase-environment': selected.path,
      },
    },
    server: {
      port: 4200,
      host: 'localhost',
      strictPort: true,
    },
    preview: {
      port: 4300,
      host: 'localhost',
    },
    plugins: [
      react(),
      nxReadySignal(),
      {
        name: 'firebase-build-target',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: '.firebase-target.json',
            source: JSON.stringify({
              environment: selected.kind,
              projectId: environment.firebase.projectId,
            }),
          });
        },
      },
    ],
    // Uncomment this if you are using workers.
    // worker: {
    //  plugins: [],
    // },
    build: {
      outDir: './dist',
      emptyOutDir: true,
      reportCompressedSize: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    test: {
      name: '@living-community-assistant/living-community-assistant',
      watch: false,
      globals: true,
      environment: 'jsdom',
      include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
      reporters: ['default'],
      coverage: {
        reportsDirectory: './test-output/vitest/coverage',
        provider: 'v8' as const,
      },
    },
  };
});
