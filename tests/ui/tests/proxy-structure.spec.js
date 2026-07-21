/**
 * proxy-structure.spec.js
 *
 * Smoke tests for the Proxy section within the Settings page.
 * (/proxy redirects to /settings which contains a "Proxy" collapsible section)
 *
 * Checks:
 *   1. "Settings" heading is visible (the page /proxy redirects to /settings).
 *   2. "Active" badge is visible (mock returns running: true).
 *   3. "Proxy" section header is present.
 *   4. Listen Address label is shown.
 *   5. Status "Running" is shown.
 */

import { test, expect } from './fixtures.js';

test.describe('Proxy page — structure', () => {
  test.beforeEach(async ({ page }) => {
    // /proxy redirects to /settings
    await page.goto('/proxy', { waitUntil: 'domcontentloaded' });
    await page.locator('text=Settings').first().waitFor({ state: 'visible', timeout: 10000 });
  });

  test('"Settings" heading is visible', async ({ page }) => {
    const heading = page.locator('text=Settings').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('"Active" badge is visible', async ({ page }) => {
    // The proxy badge shows "Active" when proxy is running (mock returns running: true)
    const badge = page.locator('text=Active').first();
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test('"Proxy" section header is visible', async ({ page }) => {
    // The section label is "PROXY" (uppercase via CSS) — match case-insensitively
    const title = page.locator('text=Proxy').first();
    await expect(title).toBeVisible({ timeout: 5000 });
  });

  test('listen address label is shown', async ({ page }) => {
    const addr = page.locator('text=Listen Address').first();
    await expect(addr).toBeVisible({ timeout: 5000 });
  });

  test('"Running" status is shown', async ({ page }) => {
    const status = page.locator('text=Running').first();
    await expect(status).toBeVisible({ timeout: 5000 });
  });
});
