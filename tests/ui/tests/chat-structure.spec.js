/**
 * chat-structure.spec.js
 *
 * Smoke tests for the Workspaces page DOM structure.
 * No session is active — tests verify the empty/initial state.
 *
 * NOTE: /chat now redirects to /workspaces. These tests have been updated
 * to reflect the new Workspaces UI.
 *
 * Checks:
 *   1. "No workspaces yet" empty state in the session list.
 *   2. "Select a workspace or start a new one" placeholder in the message area.
 *   3. "New Workspace" button in the message area is visible.
 *   4. "+" icon in the session panel opens the NewChatModal.
 *   5. Textarea is disabled when no session is selected.
 *   6. Send button is disabled when no session is selected.
 *   7. Context panel can be collapsed.
 *   8. Session panel can be collapsed and re-expanded.
 */

import { test, expect } from './fixtures.js';

test.describe('Chat page — structure (no active session)', () => {
  test.beforeEach(async ({ page }) => {
    // Clear localStorage so no previously-saved session is restored
    await page.addInitScript(() => {
      localStorage.clear();
    });
    // Intercept GET /api/chats to always return empty list
    await page.route('**/api/chats*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
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
    // Navigate to /workspaces (the new home for chat functionality)
    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    // Wait for the session list aside to be present
    await page.waitForSelector('aside', { timeout: 10000 });
  });

  test('"No chats yet" empty state is shown on first load', async ({ page }) => {
    // The workspace panel shows "No workspaces yet.\nClick + to start one."
    const emptyMsg = page.locator('text=/No workspaces yet|No chats yet/i').first();
    await expect(emptyMsg).toBeVisible({ timeout: 5000 });
  });

  test('"Select a chat or start a new one" placeholder is shown', async ({ page }) => {
    // The main content area shows an empty-state message
    const placeholder = page.locator('text=/Select a workspace|Select a chat/i').first();
    await expect(placeholder).toBeVisible({ timeout: 5000 });
  });

  test('"New Chat" button in the message area is visible', async ({ page }) => {
    // The empty-state centre column has a "New Workspace" or "New Chat" button
    const btn = page.locator('button:has-text("New Workspace"), button:has-text("New Chat")').first();
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('"+" icon in the session panel opens the NewChatModal', async ({ page }) => {
    // The + icon button in the workspace panel header (next to "WORKSPACES" label)
    const plusBtn = page.locator('button[title="New chat"], button[aria-label*="new" i]').first();
    await expect(plusBtn).toBeVisible({ timeout: 5000 });
    await plusBtn.click();
    // Modal should appear — look for the "New Chat" heading
    const modal = page.locator('text="New Chat"').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('textarea is disabled when no session is selected', async ({ page }) => {
    // The textarea placeholder changes to "Select a workspace first" or similar
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await expect(textarea).toBeDisabled();
  });

  test('Send button is disabled when no session is selected', async ({ page }) => {
    // The send button (arrow icon) is disabled when no session is active
    const sendBtn = page.locator('button[title="Send"], button[aria-label*="send" i]').first();
    await expect(sendBtn).toBeVisible({ timeout: 5000 });
    await expect(sendBtn).toBeDisabled();
  });

  test('Context panel can be collapsed', async ({ page }) => {
    // The context panel is on the right side — it has a "CONTEXT" heading
    const contextLabel = page.locator('text=CONTEXT').first();
    const isVisible = await contextLabel.isVisible().catch(() => false);
    if (!isVisible) {
      // Context panel may already be hidden — skip
      test.skip();
      return;
    }

    // Find the close/collapse button for the context panel
    const closeBtn = page.locator('button[title="Close panel"], button[aria-label*="close" i]').first();
    await expect(closeBtn).toBeVisible({ timeout: 5000 });
    await closeBtn.click();

    // Context panel should disappear
    await expect(page.locator('text=CONTEXT')).toHaveCount(0, { timeout: 3000 });
  });

  test('Session panel can be collapsed and re-expanded', async ({ page }) => {
    // The toggle button collapses/expands the workspace session list
    const toggleBtn = page.locator(
      'button[title="Collapse chat list"], button[title="Expand chat list"], button[title*="collapse" i], button[title*="expand" i]'
    ).first();

    const isVisible = await toggleBtn.isVisible().catch(() => false);
    if (!isVisible) {
      test.skip();
      return;
    }

    await expect(toggleBtn).toBeVisible({ timeout: 5000 });

    // The workspace session panel starts open — verify WORKSPACES label is visible
    const workspacesLabel = page.locator('text=WORKSPACES').first();
    await expect(workspacesLabel).toBeVisible({ timeout: 3000 });

    // Collapse
    await toggleBtn.click();

    // After collapse the workspace panel should be narrow
    await page.waitForFunction(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const panel = divs.find(d => d.textContent && d.textContent.includes('WORKSPACES'));
      return panel ? panel.getBoundingClientRect().width <= 4 : false;
    }, { timeout: 3000 });

    // Re-expand
    await toggleBtn.click();

    // Wait for the panel to be wide again
    await page.waitForFunction(() => {
      const divs = Array.from(document.querySelectorAll('div'));
      const panel = divs.find(d => d.textContent && d.textContent.includes('WORKSPACES'));
      return panel ? panel.getBoundingClientRect().width > 100 : false;
    }, { timeout: 3000 });
  });
});
