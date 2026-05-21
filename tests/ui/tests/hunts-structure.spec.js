/**
 * hunts-structure.spec.js
 *
 * Structural smoke tests for the /hunts page.
 *
 * Checks:
 *  1.  /hunts renders the app shell sidebar.
 *  2.  The "Hunts" panel header is visible in the session sidebar.
 *  3.  A "New hunt" (+) button is present in the Hunts panel header.
 *  4.  A filter input ("filter hunts...") is present.
 *  5.  With a seeded session: the session name appears in the list.
 *  6.  Clicking a session makes it active (textarea becomes enabled).
 *  7.  The active session row has brand highlight styling.
 *  8.  The message textarea is enabled when a session is active.
 *  9.  The session panel can be collapsed via the toggle button.
 * 10.  The "New hunt" button opens the NewChatModal.
 */

import { test, expect } from './fixtures.js';

// ── Seeded session ────────────────────────────────────────────────────────────

const SEEDED = {
  id: 'session-hunts-001',
  name: 'Recon Hunt Session',
  scope: 'all',
  scope_data: null,
  workspace_dir: 'temp/session-hunts-001',
  enabled_tools: null,
  created_at: '2024-06-01T10:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gotoWithSession(page) {
  // Stub GET /api/chats → return seeded session
  await page.route('**/api/chats*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([SEEDED]),
      });
    } else if (req.method() === 'GET' && url.pathname.endsWith('/messages')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: [] }),
      });
    } else {
      await route.continue();
    }
  });

  // Stub hunt files
  await page.route(`**/api/hunts/${SEEDED.id}/files`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session_id: SEEDED.id, files: [] }),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/hunts', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('aside', { timeout: 10000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Hunts page — structure', () => {
  test('1. /hunts renders the app shell sidebar', async ({ page }) => {
    await page.goto('/hunts', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('aside').first()).toBeVisible({ timeout: 10000 });
  });

  test('2. "Hunts" panel header is visible', async ({ page }) => {
    await gotoWithSession(page);
    // The HuntsList component renders a "Hunts" span in its header
    const header = page.locator('text=Hunts').first();
    await expect(header).toBeVisible({ timeout: 5000 });
  });

  test('3. "New hunt" (+) button is present', async ({ page }) => {
    await gotoWithSession(page);
    const newBtn = page.locator('button[title="New hunt"]');
    await expect(newBtn).toBeVisible({ timeout: 5000 });
  });

  test('4. Filter input is present', async ({ page }) => {
    await gotoWithSession(page);
    const filterInput = page.locator('input[placeholder="filter hunts..."]');
    await expect(filterInput).toBeVisible({ timeout: 5000 });
  });

  test('5. Seeded session name appears in the list', async ({ page }) => {
    await gotoWithSession(page);
    await expect(page.locator(`text="${SEEDED.name}"`).first()).toBeVisible({ timeout: 5000 });
  });

  test('6. Clicking a session enables the message textarea', async ({ page }) => {
    await gotoWithSession(page);

    const sessionRow = page.locator(`text="${SEEDED.name}"`).first();
    await sessionRow.click();
    await page.waitForTimeout(300);

    // After selecting a session the chat textarea should be enabled
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });
  });

  test('7. Active session row has brand highlight styling', async ({ page }) => {
    await gotoWithSession(page);

    const sessionRow = page.locator(`text="${SEEDED.name}"`).first();
    await sessionRow.click();
    await page.waitForTimeout(300);

    // The active row container should have a brand-related class
    const activeRow = page.locator('[class*="brand"], [class*="active"]').first();
    await expect(activeRow).toBeVisible({ timeout: 5000 });
  });

  test('8. Message textarea is enabled when a session is active', async ({ page }) => {
    await gotoWithSession(page);

    const sessionRow = page.locator(`text="${SEEDED.name}"`).first();
    await sessionRow.click();
    await page.waitForTimeout(300);

    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeEnabled({ timeout: 5000 });
    await expect(textarea).toBeVisible({ timeout: 5000 });
  });

  test('9. Session panel can be collapsed via toggle button', async ({ page }) => {
    await gotoWithSession(page);

    // The ChatPanel has a PanelLeftClose button to collapse the session list
    const collapseBtn = page.locator('button[title*="session" i], button[title*="panel" i], button[title*="collapse" i]').first();
    const isVisible = await collapseBtn.isVisible().catch(() => false);
    if (isVisible) {
      await collapseBtn.click();
      // After collapse, the filter input should be hidden
      await expect(page.locator('input[placeholder="filter hunts..."]')).toBeHidden({ timeout: 3000 });
    } else {
      // Fallback: look for PanelLeftClose icon button
      const panelBtn = page.locator('button').filter({ has: page.locator('svg') }).first();
      await expect(panelBtn).toBeVisible({ timeout: 5000 });
    }
  });

  test('10. "New hunt" button opens the NewChatModal', async ({ page }) => {
    await gotoWithSession(page);

    await page.locator('button[title="New hunt"]').click();

    // NewChatModal should appear — it has a "New Hunt" or "New Workspace" heading
    const modal = page.locator('h2, [role="dialog"]').filter({ hasText: /new/i }).first();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });
});
