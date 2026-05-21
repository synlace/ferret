/**
 * playwright.config.cjs
 *
 * Playwright configuration for FERRET UI end-to-end tests.
 *
 * ── Mock API server ───────────────────────────────────────────────────────────
 * globalSetup starts a mock HTTP server on port 18000 (FERRET_MOCK_PORT) before
 * any tests run. globalTeardown stops it after all tests complete.
 * Port 18000 avoids conflicts with the real FERRET API (port 8000).
 *
 * ── Next.js dev server ────────────────────────────────────────────────────────
 * The webServer block auto-starts `next dev` in src/apps/ui/ with
 * NEXT_PUBLIC_API_URL pointing at the mock server. Playwright waits for
 * http://localhost:3099 to be ready before running any tests.
 * Port 3099 is test-only — avoids conflicts with the dev server on 3000.
 *
 * ── Running tests ─────────────────────────────────────────────────────────────
 *   cd tests/ui && npx playwright test
 *   just test ui
 */

'use strict';

const { defineConfig } = require('@playwright/test');
const path = require('path');

const MOCK_PORT = parseInt(process.env.FERRET_MOCK_PORT || '18000', 10);
// Use a dedicated test port so the test server never conflicts with the
// dev server on 3000 (which may be running with a different NEXT_PUBLIC_API_URL).
const UI_PORT = parseInt(process.env.FERRET_UI_PORT || '3099', 10);
const UI_DIR = path.resolve(__dirname, '../../src/apps/ui');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  workers: process.env.PLAYWRIGHT_WORKERS
    ? parseInt(process.env.PLAYWRIGHT_WORKERS, 10)
    : 4,
  fullyParallel: true,
  reporter: [['html', { open: 'never' }]],

  // globalSetup starts the mock API server before any test worker runs.
  // globalTeardown stops it after all tests complete.
  globalSetup: './global-setup.cjs',
  globalTeardown: './global-teardown.cjs',

  // Auto-start Next.js dev server with mock API URL baked in.
  // Uses port 3099 (not 3000) so it never conflicts with `just up` dev server.
  // reuseExistingServer: true — safe because port 3099 is test-only.
  webServer: {
    command: `NEXT_PUBLIC_API_URL=http://127.0.0.1:${MOCK_PORT} NEXT_DIST_DIR=.next-test PORT=${UI_PORT} npm run dev`,
    url: `http://localhost:${UI_PORT}`,
    reuseExistingServer: true,
    cwd: UI_DIR,
    timeout: 180000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
    colorScheme: 'dark',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],

  outputDir: 'test-results/',
  preserveOutput: 'always',
});
