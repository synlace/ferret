/**
 * fixtures.js — Playwright test fixtures for the FERRET Next.js UI.
 *
 * Provides an extended `test` object with a `page` fixture that:
 *   - Navigates to the app root before each test
 *   - Waits for the app shell (sidebar) to be ready
 *
 * The UI is a standard Next.js web app running at http://localhost:3000.
 * No browser extension loading is required — tests use a standard page fixture.
 *
 * ── Mock API ──────────────────────────────────────────────────────────────────
 * The Next.js dev server is started by playwright.config.cjs with
 * NEXT_PUBLIC_API_URL=http://127.0.0.1:18000, so all API calls hit the mock
 * server started by global-setup.cjs.
 *
 * Usage:
 *   import { test, expect } from './fixtures.js';
 */

import { test as base, expect } from '@playwright/test';

const MOCK_PORT = parseInt(process.env.FERRET_MOCK_PORT || '18000', 10);

/**
 * The base URL of the mock API server.
 * Useful for tests that want to call the mock API directly.
 */
export const MOCK_API_URL = `http://127.0.0.1:${MOCK_PORT}`;

/**
 * Extended test fixture.
 *
 * The `page` fixture navigates to '/' and waits for the app shell sidebar
 * to be visible before handing control to the test.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    // Navigate to root — Next.js redirects / → /history
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Wait for the sidebar to be present (app shell has rendered)
    await page.waitForSelector('aside', { timeout: 15000 });

    await use(page);
  },
});

export { expect };
