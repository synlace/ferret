/**
 * chat-sessions.spec.js
 *
 * Tests for chat session lifecycle on the Chat page.
 *
 * Checks:
 *   9.  Creating a new session adds it to the session list.
 *  10.  Clicking a session in the list loads it as active (header + textarea enabled).
 *  11.  Active session row has the orange highlight.
 *  12.  Deleting a session removes it from the list.
 *  13.  Last active session is restored on page reload (localStorage).
 *
 * The mock server's GET /api/chats?seeded=one returns a pre-built session so
 * tests that need an existing session don't have to create one first.
 */

import { test, expect } from './fixtures.js';

// Helper: navigate to /chat with the seeded session already in the list
async function gotoWithSeededSession(page) {
  // The mock returns the seeded session when ?seeded=one is in the URL, but
  // the UI always calls /api/chats?project_id=temp.  We intercept that call
  // and return the seeded session instead.
  await page.route('**/api/chats*', async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            id: 'session-seeded-001',
            name: 'Seeded Test Session',
            scope: 'all',
            scope_data: null,
            created_at: '2024-06-01T10:00:00Z',
          },
        ]),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('aside', { timeout: 10000 });
}

test.describe('Chat page — session lifecycle', () => {
  test('creating a new session adds it to the session list', async ({ page }) => {
    // Clear localStorage so no previously-saved sessions interfere
    await page.addInitScript(() => { localStorage.clear(); });

    // Intercept POST /api/chats to return a new session
    const createdSession = {
      id: 'session-created-001',
      name: 'My Test Session',
      scope: 'all',
      scope_data: null,
      created_at: new Date().toISOString(),
    };

    await page.route('**/api/chats**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());

      if (req.method() === 'POST' && url.pathname === '/api/chats') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(createdSession),
        });
        return;
      }
      // GET /api/chats — return empty initially
      if (req.method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    // Open the NewChatModal via the + button
    const plusBtn = page.locator('aside button[title="New chat"]').first();
    await plusBtn.click();

    // Modal should appear — h2 heading "New Chat"
    const modalHeading = page.locator('h2:has-text("New Chat")');
    await expect(modalHeading).toBeVisible({ timeout: 5000 });

    // Type a name and submit
    const nameInput = page.locator('input[placeholder*="Auth endpoint"]');
    await nameInput.fill('My Test Session');
    await nameInput.press('Enter');

    // The session should appear in the chat session list aside
    // (the second aside — the first is the nav sidebar)
    const sessionItem = page.locator('text=My Test Session').first();
    await expect(sessionItem).toBeVisible({ timeout: 5000 });
  });

  test('clicking a session loads it as active', async ({ page }) => {
    await gotoWithSeededSession(page);

    // The seeded session should be in the list
    const sessionItem = page.locator('text=Seeded Test Session').first();
    await expect(sessionItem).toBeVisible({ timeout: 5000 });

    // Click it
    await sessionItem.click();

    // Chat header should show the session name
    const header = page.locator('section div:has-text("Seeded Test Session")').first();
    await expect(header).toBeVisible({ timeout: 5000 });

    // Textarea should now be enabled (placeholder changes)
    const textarea = page.locator('textarea[placeholder*="Message"]');
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await expect(textarea).toBeEnabled();
  });

  test('active session row has the orange highlight', async ({ page }) => {
    await gotoWithSeededSession(page);

    const sessionItem = page.locator('text=Seeded Test Session').first();
    await sessionItem.click();

    // The active row should have an orange highlight class
    const activeRow = page.locator('[class*="orange"]').first();
    await expect(activeRow).toBeVisible({ timeout: 5000 });
  });

  test('deleting a session removes it from the list', async ({ page }) => {
    await gotoWithSeededSession(page);

    const sessionItem = page.locator('text=Seeded Test Session').first();
    await expect(sessionItem).toBeVisible({ timeout: 5000 });

    // Hover over the session row to reveal the delete button
    const sessionRow = page.locator('aside div').filter({ hasText: 'Seeded Test Session' }).first();
    await sessionRow.hover();

    // Click the trash icon (title="Delete")
    const deleteBtn = sessionRow.locator('button[title="Delete"]');
    await expect(deleteBtn).toBeVisible({ timeout: 3000 });
    await deleteBtn.click();

    // Session should be gone
    await expect(sessionItem).toHaveCount(0, { timeout: 5000 });

    // Empty state should return
    const emptyMsg = page.locator('text=/No workspaces yet|No chats yet/i').first();
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });
  });

  test('last active session is restored on page reload', async ({ page }) => {
    await gotoWithSeededSession(page);

    // Click the seeded session to make it active
    const sessionItem = page.locator('text=Seeded Test Session').first();
    await sessionItem.click();

    // Verify it's active
    const textarea = page.locator('textarea[placeholder*="Message"]');
    await expect(textarea).toBeEnabled({ timeout: 5000 });

    // Reload the page (keeping the same route intercept)
    await gotoWithSeededSession(page);

    // The session should still be active (localStorage restores it)
    const activeRow = page.locator('[class*="orange"]').first();
    await expect(activeRow).toBeVisible({ timeout: 8000 });
  });
});
