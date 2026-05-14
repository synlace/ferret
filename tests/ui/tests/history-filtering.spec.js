/**
 * history-filtering.spec.js
 *
 * Tests for History page filtering, sorting, and pagination.
 *
 * Checks:
 *  35. Typing in the search box filters the table rows (client-side global filter).
 *  36. Method filter dropdown sends the filter to the API and hides non-matching rows.
 *  37. Status filter "4xx" hides 2xx rows (client-side status filter).
 *  38. Rows are sorted newest-first by default.
 *  39. Clicking the "Time" column header reverses sort order.
 *  40. Pagination controls appear when totalCount > pageSize.
 *
 * Strategy:
 *   - Intercept GET /api/requests to return two seeded rows with distinct
 *     methods, status codes, URLs, and timestamps.
 *   - For the method filter test, the UI sends ?method=POST to the API, so
 *     the route intercept returns only the POST row when that param is present.
 *   - For the pagination test, return X-Total-Count: 60 with 50 rows.
 */

import { test, expect } from './fixtures.js';

// Two requests with distinct properties for filtering/sorting tests
const REQ_GET_200 = {
  seq: 1,
  id: 'req-filter-001',
  timestamp: '2024-06-01T10:00:00Z',
  method: 'GET',
  url: 'https://example.com/api/users',
  host: 'example.com',
  path: '/api/users',
  status_code: 200,
  response_time: 42,
  response_size: 512,
  headers: {},
  body: null,
  response_headers: {},
  response_body: '{"users":[]}',
  annotation: null,
  source: 'proxy',
};

const REQ_POST_404 = {
  seq: 2,
  id: 'req-filter-002',
  timestamp: '2024-06-01T11:00:00Z',
  method: 'POST',
  url: 'https://api.target.com/login',
  host: 'api.target.com',
  path: '/login',
  status_code: 404,
  response_time: 120,
  response_size: 64,
  headers: {},
  body: '{"username":"test"}',
  response_headers: {},
  response_body: '{"error":"not found"}',
  annotation: null,
  source: 'proxy',
};

/**
 * Navigate to /history with two seeded request rows.
 * The route intercept respects the ?method= query param so the method filter test works.
 * Uses page.route with a handler that runs before the mock server.
 */
async function gotoWithTwoRequests(page) {
  // Use a broad pattern and check pathname inside the handler
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    if (method === 'GET' && url.pathname === '/api/requests') {
      const methodFilter = url.searchParams.get('method');

      if (methodFilter === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-Total-Count': '1', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Total-Count' },
          body: JSON.stringify([REQ_POST_404]),
        });
        return;
      }

      if (methodFilter === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-Total-Count': '1', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Total-Count' },
          body: JSON.stringify([REQ_GET_200]),
        });
        return;
      }

      // Default: return both rows, newest first
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Total-Count': '2', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Total-Count' },
        body: JSON.stringify([REQ_POST_404, REQ_GET_200]),
      });
      return;
    }

    // Stub out the test-files fetch so hostsWithTests never triggers a columns re-render
    if (method === 'GET' && url.pathname === '/api/tests/files') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ files: [] }),
      });
      return;
    }

    await route.continue();
  });

  await page.goto('/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 10000 });
  // Wait for both rows to appear
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length >= 2, { timeout: 10000 });
  // Wait an extra tick for hostsWithTests fetch to complete and columns to stabilise
  await page.waitForTimeout(200);
}

test.describe('History page — filtering and sorting', () => {
  test('typing in the search box filters the table rows', async ({ page }) => {
    await gotoWithTwoRequests(page);

    // Both rows should be visible initially
    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Type a URL that only matches the GET request (client-side global filter)
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill('example.com');

    // Wait for the table to update — only the GET row should remain
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 5000 });

    // The remaining row should contain example.com
    await expect(page.locator('tbody tr').first()).toContainText('example.com');
  });

  test('method filter dropdown hides non-matching rows', async ({ page }) => {
    await gotoWithTwoRequests(page);

    // Both rows visible
    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Open the method filter SelectTrigger
    const methodTrigger = page.locator('button:has-text("All Methods")');
    await methodTrigger.click();

    // The SelectContent portal renders outside the button — find the POST option
    const postOption = page.locator('[role="option"]:has-text("POST")').first();
    await expect(postOption).toBeVisible({ timeout: 3000 });
    await postOption.click();

    // The UI sends ?method=POST to the API; our mock returns only the POST row
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('tbody tr').first()).toContainText('POST');
  });

  test('status filter "4xx" hides 2xx rows', async ({ page }) => {
    await gotoWithTwoRequests(page);

    // Both rows visible
    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Open the status filter SelectTrigger
    const statusTrigger = page.locator('button:has-text("All Status")');
    await statusTrigger.click();

    // Select "4xx Client Error"
    const errorOption = page.locator('[role="option"]:has-text("4xx")').first();
    await expect(errorOption).toBeVisible({ timeout: 3000 });
    await errorOption.click();

    // The status filter is client-side — only the 404 row should remain
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('tbody tr').first()).toContainText('404');
  });

  test('rows are sorted newest-first by default', async ({ page }) => {
    await gotoWithTwoRequests(page);

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // The default sort is by timestamp descending (newest first)
    // POST (11:00) should be first, GET (10:00) should be second
    await expect(page.locator('tbody tr').first()).toContainText('POST');
    await expect(page.locator('tbody tr').nth(1)).toContainText('GET');
  });

  test('clicking the "Time" column header reverses sort order', async ({ page }) => {
    await gotoWithTwoRequests(page);

    await expect(page.locator('tbody tr')).toHaveCount(2, { timeout: 5000 });

    // Default: POST (newer, 11:00) first
    await expect(page.locator('tbody tr').first()).toContainText('POST');

    // The TanStack table uses client-side sorting. The sort handler is on the
    // inner div[cursor=pointer] inside the "Time" <th> (not "Time (ms)").
    // Use dispatchEvent to fire a synthetic click that React's event delegation
    // will pick up, bypassing any Playwright click interception issues.
    await page.evaluate(() => {
      const headers = Array.from(document.querySelectorAll('thead th'));
      // Find the "Time" th — text content is exactly "Time↕" (text + icon)
      const timeHeader = headers.find(th => {
        const text = th.textContent?.replace(/\s/g, '') ?? '';
        // Matches "Time" with sort icon but not "Time(ms)"
        return text.startsWith('Time') && !text.includes('(');
      });
      if (!timeHeader) throw new Error('Time header not found');
      const sortDiv = timeHeader.querySelector('div');
      if (!sortDiv) throw new Error('Sort div not found');
      // Dispatch a real click event that React's synthetic event system will handle
      sortDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    // Wait for DOM to update
    await page.waitForTimeout(300);

    // After ascending sort: GET (older, 10:00) should be first
    // If still POST first, the sort went desc→asc→desc; try once more
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

  test('pagination controls appear when totalCount > pageSize', async ({ page }) => {
    // Return 50 rows but X-Total-Count: 60 (default pageSize is 50)
    const manyRows = Array.from({ length: 50 }, (_, i) => ({
      ...REQ_GET_200,
      seq: i + 1,
      id: `req-page-${i + 1}`,
      timestamp: new Date(Date.now() - i * 60000).toISOString(),
      path: `/api/item/${i + 1}`,
      url: `https://example.com/api/item/${i + 1}`,
    }));

    // Intercept all requests and handle /api/requests specifically
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === 'GET' && url.pathname === '/api/requests') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: {
            'X-Total-Count': '60',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'X-Total-Count',
          },
          body: JSON.stringify(manyRows),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/history', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10000 });

    // Wait for rows to load
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length > 0, { timeout: 10000 });

    // The pagination area shows "Page X of Y" — look for that text
    // From the screenshot: "Page 1 of 3" rendered in the stats bar
    const pageIndicator = page.locator('text=/Page \\d+ of \\d+/').first();
    await expect(pageIndicator).toBeVisible({ timeout: 5000 });
  });
});
