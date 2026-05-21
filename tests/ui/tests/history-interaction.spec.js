/**
 * history-interaction.spec.js
 *
 * Tests for the History page DetailPanel and row interactions.
 *
 * Checks:
 *  1. Clicking a table row expands the DetailPanel inline.
 *  2. DetailPanel shows "Request" and "Response" pane headers.
 *  3. DetailPanel has a "Send to Gnaw" icon button.
 *  4. DetailPanel has a "Maximize" icon button.
 *  5. Clicking the same row again collapses the DetailPanel.
 *
 * Strategy:
 *   - The mock server returns two seeded rows by default — no page.route needed.
 *   - Rows expand on click (no separate eye button in the new UI).
 *   - DetailPanel renders CodeMirror editors for request/response.
 */

import { test, expect } from './fixtures.js';

async function gotoHistory(page) {
  await page.goto('/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 10000 });
  // Wait for at least one row to appear
  await page.waitForSelector('tbody tr', { timeout: 10000 });
  await page.waitForTimeout(200);
}

test.describe('History page — DetailPanel interactions', () => {
  test('clicking a table row expands the DetailPanel', async ({ page }) => {
    await gotoHistory(page);

    // Click the first row to expand the DetailPanel
    const row = page.locator('tbody tr').first();
    await row.click();

    // DetailPanel shows "Request" and "Response" pane headers
    const requestHeader = page.locator('text=Request').first();
    await expect(requestHeader).toBeVisible({ timeout: 5000 });

    const responseHeader = page.locator('text=Response').first();
    await expect(responseHeader).toBeVisible({ timeout: 5000 });
  });

  test('DetailPanel shows request content in CodeMirror editor', async ({ page }) => {
    await gotoHistory(page);

    const row = page.locator('tbody tr').first();
    await row.click();

    // CodeMirror renders content in .cm-content divs
    const cmContent = page.locator('.cm-content').first();
    await expect(cmContent).toBeVisible({ timeout: 5000 });
    // The first row is POST api.target.com/login (newest first)
    await expect(cmContent).toContainText('POST', { timeout: 5000 });
  });

  test('DetailPanel has a "Send to Gnaw" icon button', async ({ page }) => {
    await gotoHistory(page);

    const row = page.locator('tbody tr').first();
    await row.click();

    // The action sidebar has a "Send to Gnaw" button
    const gnawBtn = page.locator('button[title="Send to Gnaw"]');
    await expect(gnawBtn).toBeVisible({ timeout: 5000 });
  });

  test('DetailPanel has a Maximize button', async ({ page }) => {
    await gotoHistory(page);

    const row = page.locator('tbody tr').first();
    await row.click();

    // The action sidebar has a Maximize button
    const maxBtn = page.locator('button[title="Maximize"]');
    await expect(maxBtn).toBeVisible({ timeout: 5000 });
  });

  test('clicking the same row again collapses the DetailPanel', async ({ page }) => {
    await gotoHistory(page);

    const row = page.locator('tbody tr').first();

    // Expand
    await row.click();
    const gnawBtn = page.locator('button[title="Send to Gnaw"]');
    await expect(gnawBtn).toBeVisible({ timeout: 5000 });

    // Collapse — click the same row again
    await row.click();
    await expect(page.locator('button[title="Send to Gnaw"]')).toHaveCount(0, { timeout: 3000 });
  });
});
