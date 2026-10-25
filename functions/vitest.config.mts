import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    name: 'functions',
    environment: 'node',
    globals: true,
    watch: false,
    include: ['src/**/*.spec.ts'],
  },
});
