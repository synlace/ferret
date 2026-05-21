/**
 * pounce-structure.spec.js
 *
 * Smoke tests for the Pounce page DOM structure.
 *
 * Checks:
 *   1. "Pounce" heading is visible.
 *   2. "Coming Soon" badge is visible.
 *   3. Placeholder description text is visible.
 */

import { test, expect } from './fixtures.js';

test.describe('Pounce page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/pounce', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10000 });
  });

  test('"Pounce" heading is visible', async ({ page }) => {
    const heading = page.locator('h1:has-text("Pounce")');
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('"Coming Soon" badge is visible', async ({ page }) => {
    const badge = page.locator('text=Coming Soon').first();
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test('placeholder description text is visible', async ({ page }) => {
    // "Automated payload fuzzing and attack module. Coming soon."
    const desc = page.locator('text=fuzzing').first();
    await expect(desc).toBeVisible({ timeout: 5000 });
  });
});
