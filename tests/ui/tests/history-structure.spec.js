/**
 * history-structure.spec.js
 *
 * Smoke tests for the History page DOM structure.
 *
 * Checks:
 *   1. "Proxy History" heading is visible.
 *   2. Search input is present.
 *   3. Refresh button is present.
 *   4. Export button is present.
 *   5. Clear button is present.
 *   6. Stats bar labels are present (Requests, Success, Avg, Data).
 *   7. No error banner shown when API returns empty list.
 */

import { test, expect } from './fixtures.js';

test.describe('History page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/history', { waitUntil: 'domcontentloaded' });
    await page.locator('text="Proxy History"').first().waitFor({ state: 'visible', timeout: 10000 });
    // Small settle for React hydration
    await page.waitForTimeout(300);
  });

  test('"Proxy History" heading is visible', async ({ page }) => {
    const heading = page.locator('text="Proxy History"').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('search input is present', async ({ page }) => {
    // SearchBar renders an input for free-form query text
    const input = page.locator('input[type="text"], input:not([type])').first();
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test('Refresh button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("Refresh")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('Export button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("Export")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('Clear button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("Clear")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('stats bar labels are present', async ({ page }) => {
    for (const label of ['Requests', 'Success', 'Avg', 'Data']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('no error banner shown when API returns empty list', async ({ page }) => {
    await page.waitForTimeout(500);
    // Error banner contains "⚠" — should not be present on clean empty response
    const errorBanner = page.locator('[class*="red"] >> text=⚠');
    await expect(errorBanner).toHaveCount(0);
  });
});
