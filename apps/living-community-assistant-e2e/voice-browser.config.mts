import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Isolated browser fixture: never reads local production credentials or config.
export default defineConfig({
  root: resolve(import.meta.dirname, '../living-community-assistant'),
  define: { __FIREBASE_USE_EMULATOR__: true },
  resolve: {
    alias: {
      '#firebase-environment': resolve(import.meta.dirname, 'environment.ts'),
    },
  },
  server: { host: 'localhost', port: 4201, strictPort: true },
  plugins: [react()],
});
