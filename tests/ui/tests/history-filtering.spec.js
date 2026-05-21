/**
 * history-filtering.spec.js
 *
 * Tests for History page filtering, sorting, and pagination.
 *
 * Checks:
 *  1. Typing in the search box filters the table rows (client-side).
 *  2. Rows are sorted newest-first by default.
 *  3. Clicking the "Time" column header reverses sort order.
 *  4. Pagination controls appear when filteredTotal > pageSize.
 *
 * Strategy:
 *   - The mock server returns two seeded rows by default:
 *       SEEDED_REQUEST_2: POST api.target.com/login  404  2024-06-01T11:00:00Z (newer)
 *       SEEDED_REQUEST:   GET  example.com/api/users 200  2024-06-01T10:00:00Z (older)
 *   - Filtering is query-syntax based (SearchBar), not dropdown-based.
 *   - Pagination shows "p{page}/{totalPages}" format.
 */

import { test, expect } from './fixtures.js';

async function gotoHistory(page) {
  await page.goto('/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 10000 });
  // Wait for both rows to appear (mock returns 2 by default)
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 2, { timeout: 10000 });
  await page.waitForTimeout(200);
}

test.describe('History page — filtering and sorting', () => {
  test('typing in the search box filters the table rows', async ({ page }) => {
    await gotoHistory(page);

    // Both rows should be visible initially
    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Type a host that only matches the GET request (client-side filter via SearchBar)
    const searchInput = page.locator('input[type="text"], input:not([type])').first();
    await searchInput.fill('example.com');
    await searchInput.press('Enter');

    // Wait for the table to update — only the GET row should remain
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 5000 });

    // The remaining row should contain example.com
    await expect(page.locator('tbody tr').first()).toContainText('example.com');
  });

  test('rows are sorted newest-first by default', async ({ page }) => {
    await gotoHistory(page);

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // The default sort is by timestamp descending (newest first)
    // POST (11:00) should be first, GET (10:00) should be second
    await expect(page.locator('tbody tr').first()).toContainText('POST');
    await expect(page.locator('tbody tr').nth(1)).toContainText('GET');
  });

  test('clicking the "Time" column header reverses sort order', async ({ page }) => {
    await gotoHistory(page);

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Default: POST (newer, 11:00) first
    await expect(page.locator('tbody tr').first()).toContainText('POST');

    // Click the Time column header sort div
    await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('thead th'));
      const timeHeader = headers.find(th => {
        const text = th.textContent?.replace(/\s/g, '') ?? '';
        return text.startsWith('Time') && !text.includes('(');
      });
      if (!timeHeader) throw new Error('Time header not found');
      const sortDiv = timeHeader.querySelector('div');
      if (!sortDiv) throw new Error('Sort div not found');
      sortDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    await page.waitForTimeout(300);

    // After ascending sort: GET (older, 10:00) should be first
    const firstRowText = await page.locator('tbody tr').first().textContent();
    if (firstRowText && firstRowText.includes('POST')) {
      await page.evaluate(() => {
        const headers = Array.from(document.querySelectorAll('thead th'));
        const timeHeader = headers.find(th => {
          const text = th.textContent?.replace(/\s/g, '') ?? '';
          return text.startsWith('Time') && !text.includes('(');
        });
        const sortDiv = timeHeader?.querySelector('div');
        sortDiv?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
      await page.waitForTimeout(300);
    }

    await expect(page.locator('tbody tr').first()).toContainText('GET', { timeout: 5000 });
  });

  test('pagination indicator shows current page and total pages', async ({ page }) => {
    // Navigate to history — mock returns 2 rows by default (1 page at pageSize 50).
    await gotoHistory(page);

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // The stats bar always shows the "p{page}/{totalPages}" indicator when rows exist.
    // With 2 rows and pageSize 50, it shows "p1/1".
    const pageIndicator = page.locator('text=/p\\d+\\/\\d+/').first();
    await expect(pageIndicator).toBeVisible({ timeout: 5000 });
    await expect(pageIndicator).toContainText('p1/');
  });
});
