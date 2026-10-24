import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'socket-server',
    environment: 'node',
    globals: true,
    watch: false,
    include: ['src/**/*.spec.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
