/**
 * proxy-structure.spec.js
 *
 * Smoke tests for the Proxy Settings page DOM structure.
 *
 * Checks:
 *   1. "Proxy Settings" heading is visible.
 *   2. "Active" badge is visible.
 *   3. "Proxy Configuration" card is present.
 *   4. Listen address is shown.
 *   5. Status "Running" is shown.
 */

import { test, expect } from './fixtures.js';

test.describe('Proxy page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/proxy', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10000 });
  });

  test('"Proxy Settings" heading is visible', async ({ page }) => {
    const heading = page.locator('h1:has-text("Proxy Settings")');
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('"Active" badge is visible', async ({ page }) => {
    const badge = page.locator('text=Active').first();
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test('"Proxy Configuration" card title is visible', async ({ page }) => {
    const title = page.locator('text=Proxy Configuration').first();
    await expect(title).toBeVisible({ timeout: 5000 });
  });

  test('listen address is shown', async ({ page }) => {
    const addr = page.locator('text=Listen Address').first();
    await expect(addr).toBeVisible({ timeout: 5000 });
  });

  test('"Running" status is shown', async ({ page }) => {
    const status = page.locator('text=Running').first();
    await expect(status).toBeVisible({ timeout: 5000 });
  });
});
