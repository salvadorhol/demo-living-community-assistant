import { defineConfig, devices } from '@playwright/test';
import { nxE2EPreset } from '@nx/playwright/preset';
import { getReadyUrl, workspaceRoot } from '@nx/devkit';

// getReadyUrl moves the address to the port the server task reported.
const webServerAddress = getReadyUrl('http://localhost:4201');

// For CI, you may want to set BASE_URL to the deployed application.
const baseURL = process.env['BASE_URL'] || webServerAddress;

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import 'dotenv/config';

/**
 * See https://playwright.dev/docs/test-configuration.
 *
 * Generated as a .mts file so Node forces ESM regardless of workspace
 * `type`. Playwright routes `.mts` through its ESM loader (dynamic import,
 * bypassing the pirates CJS-compile path), and Nx's native TS strip loads
 * `.mts` directly. Playwright's configLoader auto-discovers
 * `playwright.config.mts` via its extension list
 * (.ts/.js/.mts/.mjs/.cts/.cjs).
 */
export default defineConfig({
  ...nxE2EPreset(import.meta.dirname, { testDir: './src' }),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },
  webServer: [
    {
      command:
        'npx nx build functions && node tools/start-emulators.mjs --ephemeral --test',
      timeout: 180_000,
      url: 'http://127.0.0.1:5301/demo-living-community-assistant/us-central1/health',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
      cwd: workspaceRoot,
    },
    {
      command: 'node apps/socket-server/src/voice-fixture.ts',
      env: {
        FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9399',
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8380',
        FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9398',
      },
      timeout: 30_000,
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
      cwd: workspaceRoot,
    },
    {
      command:
        'npx vite --config apps/living-community-assistant-e2e/voice-browser.config.mts',
      timeout: 30_000,
      url: webServerAddress,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 30000 },
      cwd: workspaceRoot,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
});
