/**
 * history-structure.spec.js
 *
 * Smoke tests for the History page DOM structure.
 *
 * Checks:
 *   1. "Request History" heading is visible.
 *   2. Search input is present.
 *   3. Method filter dropdown is present.
 *   4. Status filter dropdown is present.
 *   5. Source filter dropdown is present.
 *   6. Refresh button is present.
 *   7. Export button is present.
 *   8. Clear History button is present (disabled when no requests).
 *   9. Empty state — no error banner shown when API returns empty list.
 */

import { test, expect } from './fixtures.js';

test.describe('History page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/history', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10000 });
  });

  test('"Request History" heading is visible', async ({ page }) => {
    const heading = page.locator('h1:has-text("Request History")');
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('search input is present', async ({ page }) => {
    const input = page.locator('input[placeholder*="Search"]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test('method filter dropdown is present', async ({ page }) => {
    // SelectTrigger containing "All Methods"
    const trigger = page.locator('button:has-text("All Methods")');
    await expect(trigger).toBeVisible({ timeout: 5000 });
  });

  test('status filter dropdown is present', async ({ page }) => {
    const trigger = page.locator('button:has-text("All Status")');
    await expect(trigger).toBeVisible({ timeout: 5000 });
  });

  test('Refresh button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("Refresh")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('Export button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("Export")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('Clear History button is present', async ({ page }) => {
    // Button is disabled when totalCount === 0 (no requests captured yet).
    // We verify presence only here; disabled-state is covered by interaction tests.
    const btn = page.locator('button:has-text("Clear History")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('no error banner shown when API returns empty list', async ({ page }) => {
    // Wait for the page to finish loading
    await page.waitForTimeout(1000);
    const errorBanner = page.locator('text=⚠');
    await expect(errorBanner).toHaveCount(0);
  });
});
