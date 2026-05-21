/**
 * snare-structure.spec.js
 *
 * Structural smoke tests for the /snare (HTTP Intercept) page.
 *
 * Checks:
 *  1.  /snare renders the app shell sidebar.
 *  2.  "Snare" heading is visible.
 *  3.  "Snare Off" status badge is visible on initial load.
 *  4.  "Start" button is present and enabled.
 *  5.  "Intercepted" sidebar panel header is visible.
 *  6.  Empty state message is shown when no requests are intercepted.
 *  7.  "Snare Rules" section header is visible.
 *  8.  "Add rule" (+) button is present in the Snare Rules section.
 *  9.  Clicking "Start" toggles the snare state to "Snare On".
 * 10.  Clicking "Add rule" shows the rule creation form.
 */

import { test, expect } from './fixtures.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gotoSnare(page) {
  // Stub snare status endpoint
  await page.route('**/api/snare/status**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ snaring: false, intercepted_count: 0 }),
      });
    } else {
      await route.continue();
    }
  });

  // Stub snare start/stop
  await page.route('**/api/snare/start**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ snaring: true }),
    });
  });

  await page.route('**/api/snare/stop**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ snaring: false }),
    });
  });

  // Stub snare rules
  await page.route('**/api/snare/rules**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    } else if (req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'rule-001',
          name: body.name || 'Test Rule',
          host: body.host || '',
          path: body.path || '',
          method: body.method || '',
          enabled: true,
        }),
      });
    } else {
      await route.continue();
    }
  });

  // Stub WebSocket connection (snare uses WS for live intercept)
  // Playwright will handle WS connections gracefully even without a real server.

  await page.goto('/snare', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('h1', { timeout: 10000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Snare page — structure', () => {
  test('1. /snare renders the app shell sidebar', async ({ page }) => {
    await page.goto('/snare', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('aside').first()).toBeVisible({ timeout: 10000 });
  });

  test('2. "Snare" heading is visible', async ({ page }) => {
    await gotoSnare(page);
    const heading = page.locator('h1:has-text("Snare")');
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('3. "Snare Off" status badge is visible on initial load', async ({ page }) => {
    await gotoSnare(page);
    // The status badge shows "Snare Off" when not intercepting
    const badge = page.locator('text=Snare Off').first();
    await expect(badge).toBeVisible({ timeout: 5000 });
  });

  test('4. "Start" button is present and enabled', async ({ page }) => {
    await gotoSnare(page);
    const startBtn = page.locator('button:has-text("Start")').first();
    await expect(startBtn).toBeVisible({ timeout: 5000 });
    await expect(startBtn).toBeEnabled({ timeout: 5000 });
  });

  test('5. "Intercepted" sidebar panel header is visible', async ({ page }) => {
    await gotoSnare(page);
    const header = page.locator('text=Intercepted').first();
    await expect(header).toBeVisible({ timeout: 5000 });
  });

  test('6. Empty state message shown when no requests are intercepted', async ({ page }) => {
    await gotoSnare(page);
    // Empty state: "No intercepted requests"
    const emptyMsg = page.locator('text=No intercepted requests').first();
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });
  });

  test('7. "Snare Rules" section header is visible', async ({ page }) => {
    await gotoSnare(page);
    const rulesHeader = page.locator('text=Snare Rules').first();
    await expect(rulesHeader).toBeVisible({ timeout: 5000 });
  });

  test('8. "Add rule" (+) button is present in the Snare Rules section', async ({ page }) => {
    await gotoSnare(page);
    const addRuleBtn = page.locator('button[title="Add rule"]');
    await expect(addRuleBtn).toBeVisible({ timeout: 5000 });
  });

  test('9. Clicking "Start" toggles the snare state to "Snare On"', async ({ page }) => {
    await gotoSnare(page);

    // Override the toggle endpoint to return snaring: true
    await page.route('**/api/snare/**', async (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ snaring: true }),
        });
      } else {
        await route.continue();
      }
    });

    await page.locator('button:has-text("Start")').first().click();

    // After clicking Start, the badge should change to "Snare On"
    await expect(page.locator('text=Snare On').first()).toBeVisible({ timeout: 5000 });
  });

  test('10. Clicking "Add rule" shows the rule creation form', async ({ page }) => {
    await gotoSnare(page);

    await page.locator('button[title="Add rule"]').click();

    // The add-rule form should appear with a "Rule name" input
    const ruleNameInput = page.locator('input[placeholder*="Rule name"]');
    await expect(ruleNameInput).toBeVisible({ timeout: 5000 });
  });
});
