/**
 * settings-structure.spec.js
 *
 * Smoke tests for the Settings page DOM structure.
 *
 * Checks:
 *   1. "Settings" heading is visible.
 *   2. CA Certificate card is present.
 *   3. Download cert button is present and enabled.
 *      (Button text: "Download ferret-ca-cert.pem")
 *   4. Descriptive text about importing the cert is visible.
 */

import { test, expect } from './fixtures.js';

test.describe('Settings page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10000 });
  });

  test('"Settings" heading is visible', async ({ page }) => {
    const heading = page.locator('h1:has-text("Settings")');
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('CA Certificate card is present', async ({ page }) => {
    const card = page.locator('text=CA Certificate').first();
    await expect(card).toBeVisible({ timeout: 5000 });
  });

  test('download cert button is present and enabled', async ({ page }) => {
    // Button renders "Download ferret-ca-cert.pem" in idle state
    const btn = page.locator('button:has-text("ferret-ca-cert.pem")');
    await expect(btn).toBeVisible({ timeout: 5000 });
    await expect(btn).toBeEnabled({ timeout: 5000 });
  });

  test('cert import description text is visible', async ({ page }) => {
    // "Import this certificate into your browser or OS trust store…"
    const desc = page.locator('text=trust store').first();
    await expect(desc).toBeVisible({ timeout: 5000 });
  });
});
