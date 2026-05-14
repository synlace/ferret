/**
 * history-interaction.spec.js
 *
 * Tests for the History page DetailPanel and row interactions.
 *
 * Checks:
 *  29. Clicking the Eye icon expands the DetailPanel.
 *  30. "Raw" tab shows request and response textareas.
 *  31. "Annotation" tab shows "No annotation yet." when empty.
 *  32. "Send to Chat" button navigates to /chat?requestId=...
 *  33. "Repeater" button in the DetailPanel navigates to /repeater.
 *  34. Clicking the same Eye icon again collapses the DetailPanel.
 *
 * Strategy:
 *   - Intercept GET /api/requests to return a single seeded request row.
 *   - Intercept GET /api/requests/:id to return the full request object.
 *   - All other API calls fall through to the mock server.
 */

import { test, expect } from './fixtures.js';

const SEEDED_REQUEST = {
  seq: 1,
  id: 'req-seeded-001',
  timestamp: '2024-06-01T10:00:00Z',
  method: 'GET',
  url: 'https://example.com/api/users',
  host: 'example.com',
  path: '/api/users',
  status_code: 200,
  response_time: 42,
  response_size: 512,
  headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  body: null,
  response_headers: { 'Content-Type': 'application/json' },
  response_body: '{"users":[]}',
  annotation: null,
  source: 'proxy',
};

async function gotoWithOneRequest(page) {
  // Return one seeded request from the list endpoint
  await page.route('**/api/requests*', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();

    // Individual request detail
    if (method === 'GET' && url.pathname.match(/\/api\/requests\/[^/]+$/)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SEEDED_REQUEST),
      });
      return;
    }

    // List endpoint
    if (method === 'GET' && url.pathname === '/api/requests') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'X-Total-Count': '1' },
        body: JSON.stringify([SEEDED_REQUEST]),
      });
      return;
    }

    await route.continue();
  });

  await page.goto('/history', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 10000 });

  // Wait for the request row to appear
  await page.waitForSelector('tbody tr', { timeout: 10000 });
}

test.describe('History page — DetailPanel interactions', () => {
  test('clicking the Eye icon expands the DetailPanel', async ({ page }) => {
    await gotoWithOneRequest(page);

    // Click the Eye (View details) button in the actions column
    const eyeBtn = page.locator('button[title="View details"]').first();
    await expect(eyeBtn).toBeVisible({ timeout: 5000 });
    await eyeBtn.click();

    // DetailPanel should appear — it contains "Raw" and "Annotation" tab buttons
    const rawTab = page.locator('button:has-text("Raw")').first();
    await expect(rawTab).toBeVisible({ timeout: 5000 });

    const annotationTab = page.locator('button:has-text("Annotation")').first();
    await expect(annotationTab).toBeVisible({ timeout: 5000 });
  });

  test('"Raw" tab shows request and response textareas', async ({ page }) => {
    await gotoWithOneRequest(page);

    const eyeBtn = page.locator('button[title="View details"]').first();
    await eyeBtn.click();

    // The Raw tab is active by default — two textareas should be visible
    const textareas = page.locator('textarea[readonly]');
    await expect(textareas).toHaveCount(2, { timeout: 5000 });

    // First textarea (request) should contain the method and path
    const requestTextarea = textareas.first();
    const requestContent = await requestTextarea.inputValue();
    expect(requestContent).toContain('GET');
    expect(requestContent).toContain('example.com');
  });

  test('"Annotation" tab shows "No annotation yet." when empty', async ({ page }) => {
    await gotoWithOneRequest(page);

    const eyeBtn = page.locator('button[title="View details"]').first();
    await eyeBtn.click();

    // Switch to the Annotation tab
    const annotationTab = page.locator('button:has-text("Annotation")').first();
    await annotationTab.click();

    // Should show the empty state message
    const emptyMsg = page.locator('text=No annotation yet.');
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });
  });

  test('"Send to Chat" button navigates to /chat with requestId param', async ({ page }) => {
    await gotoWithOneRequest(page);

    const eyeBtn = page.locator('button[title="View details"]').first();
    await eyeBtn.click();

    // Click "Send to Chat" in the DetailPanel header
    const sendToChatBtn = page.locator('button:has-text("Send to Chat")').first();
    await expect(sendToChatBtn).toBeVisible({ timeout: 5000 });
    await sendToChatBtn.click();

    // URL should change to /chat?requestId=...
    await page.waitForURL(/\/chat\?requestId=/, { timeout: 5000 });
    expect(page.url()).toContain('/chat');
    expect(page.url()).toContain('requestId=');
  });

  test('"Repeater" button in the DetailPanel navigates to /repeater', async ({ page }) => {
    await gotoWithOneRequest(page);

    const eyeBtn = page.locator('button[title="View details"]').first();
    await eyeBtn.click();

    // Click the "Repeater" button in the DetailPanel header
    const repeaterBtn = page.locator('button:has-text("Repeater")').first();
    await expect(repeaterBtn).toBeVisible({ timeout: 5000 });
    await repeaterBtn.click();

    // URL should change to /repeater
    await page.waitForURL(/\/repeater/, { timeout: 5000 });
    expect(page.url()).toContain('/repeater');
  });

  test('clicking the same Eye icon again collapses the DetailPanel', async ({ page }) => {
    await gotoWithOneRequest(page);

    const eyeBtn = page.locator('button[title="View details"]').first();

    // Expand
    await eyeBtn.click();
    const rawTab = page.locator('button:has-text("Raw")').first();
    await expect(rawTab).toBeVisible({ timeout: 5000 });

    // Collapse — click the same Eye button again
    await eyeBtn.click();
    await expect(rawTab).toHaveCount(0, { timeout: 3000 });
  });
});
