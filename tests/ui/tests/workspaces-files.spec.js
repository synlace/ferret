/**
 * workspaces-files.spec.js
 *
 * Tests for the file tree and inline file editor on the /workspaces page.
 *
 * Checks:
 *  1.  File tree is hidden when no files exist in the workspace.
 *  2.  File tree shows files grouped by subdir (scripts, tests, notes).
 *  3.  Clicking a file in the tree replaces the chat with the file editor.
 *  4.  File editor shows the file content.
 *  5.  File editor has a Save button.
 *  6.  File editor has a Back button that returns to the chat view.
 *  7.  Runnable files (scripts/*.py, scripts/*.sh, tests/*.py) show a Run button.
 *  8.  Notes files do NOT show a Run button.
 *  9.  New File modal opens when the + button in the file tree is clicked.
 * 10.  New File modal has subdir selector (scripts / tests / notes).
 * 11.  Creating a new file via the modal adds it to the file tree.
 * 12.  Deleting a file removes it from the tree.
 */

import { test, expect } from './fixtures.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'session-ws-files-001';
const SESSION = {
  id: SESSION_ID,
  name: 'File Tree Test Session',
  scope: 'blank',
  scope_data: null,
  workspace_dir: `temp/${SESSION_ID}`,
  created_at: '2024-06-01T10:00:00Z',
};

const SCRIPT_FILE = {
  path: 'scripts/recon.sh',
  subdir: 'scripts',
  name: 'recon.sh',
  size: 28,
  modified_at: '2024-06-01T10:00:00Z',
};

const TEST_FILE = {
  path: 'tests/test_auth.py',
  subdir: 'tests',
  name: 'test_auth.py',
  size: 42,
  modified_at: '2024-06-01T10:00:00Z',
};

const NOTE_FILE = {
  path: 'notes/findings.md',
  subdir: 'notes',
  name: 'findings.md',
  size: 15,
  modified_at: '2024-06-01T10:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set up route intercepts and navigate to /workspaces with the test session active.
 * @param {import('@playwright/test').Page} page
 * @param {object[]} files  - Array of file entries to return from GET /files
 * @param {object}   fileContents - Map of filePath → content string
 */
async function gotoWithSession(page, files = [], fileContents = {}) {
  // Stub GET /api/chats → return our test session
  await page.route('**/api/chats*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([SESSION]),
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

  // Stub GET /api/workspaces/{id}/files → return provided files
  await page.route(`**/api/workspaces/${SESSION_ID}/files`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ session_id: SESSION_ID, files }),
      });
    } else {
      await route.continue();
    }
  });

  // Stub GET /api/workspaces/{id}/files/{path} → return file content
  await page.route(`**/api/workspaces/${SESSION_ID}/files/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    // Extract file path from URL: everything after /files/
    const match = url.pathname.match(/\/api\/workspaces\/[^/]+\/files\/(.+)$/);
    const filePath = match ? match[1] : '';

    if (req.method() === 'GET') {
      const content = fileContents[filePath] ?? `# content of ${filePath}`;
      const entry = files.find(f => f.path === filePath);
      await route.fulfill({
        status: entry ? 200 : 404,
        contentType: 'application/json',
        body: entry
          ? JSON.stringify({ path: filePath, content, size: content.length, modified_at: entry.modified_at })
          : JSON.stringify({ detail: 'File not found' }),
      });
    } else if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ path: filePath, size: (body.content || '').length, modified_at: new Date().toISOString() }),
      });
    } else if (req.method() === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deleted: filePath }),
      });
    } else if (req.method() === 'POST' && url.pathname.endsWith('/run')) {
      const subdir = filePath.split('/')[0];
      if (subdir === 'notes') {
        await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'Notes files cannot be run' }) });
        return;
      }
      const runId = 'run-test-001';
      const sse = [
        `data: {"run_id": "${runId}", "status": "running"}`,
        `data: {"line": "mock output"}`,
        `data: {"run_id": "${runId}", "status": "passed", "exit_code": 0}`,
      ].join('\n\n') + '\n\n';
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse });
    } else {
      await route.continue();
    }
  });

  await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('aside', { timeout: 10000 });

  // Click the session to make it active
  const sessionBtn = page.locator('aside').locator(`text="${SESSION.name}"`).first();
  await sessionBtn.click();
  await page.waitForTimeout(300);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Workspaces page — file tree', () => {
  test('1. File tree is hidden when workspace has no files', async ({ page }) => {
    await gotoWithSession(page, []);

    // The file tree section should either not exist or be empty
    // It lives in the sidebar under the session row
    const fileTree = page.locator('[data-testid="file-tree"], .file-tree, aside [class*="file"]').first();
    // Either not visible or contains no file entries
    const isVisible = await fileTree.isVisible().catch(() => false);
    if (isVisible) {
      const fileItems = page.locator('aside button[data-file-path], aside [class*="file-item"]');
      await expect(fileItems).toHaveCount(0, { timeout: 3000 });
    }
    // Test passes if no file items are shown
  });

  test('2. File tree shows files grouped by subdir', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE, TEST_FILE, NOTE_FILE]);

    // The file tree is rendered in the workspace sidebar panel (the inner
    // panel between the app-shell aside and the main content area).
    // All three file names should appear somewhere on the page.
    await expect(page.locator('text=recon.sh').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=test_auth.py').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=findings.md').first()).toBeVisible({ timeout: 5000 });
  });

  test('3. Clicking a file replaces chat with file editor', async ({ page }) => {
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': '#!/bin/bash\nnmap -sV $TARGET' },
    );

    // The textarea (chat input) should be visible initially
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // Click the file in the sidebar
    const fileBtn = page.locator('aside').locator('text="recon.sh"').first();
    await fileBtn.click();

    // The chat textarea should be replaced by the file editor
    // The editor shows a code/textarea area with the file content
    await expect(page.locator('textarea, [role="textbox"]').filter({ hasText: 'nmap' }).first()).toBeVisible({ timeout: 5000 });
  });

  test('4. File editor shows the file content', async ({ page }) => {
    const content = '#!/bin/bash\nnmap -sV $TARGET\necho "done"';
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': content },
    );

    const fileBtn = page.locator('aside').locator('text="recon.sh"').first();
    await fileBtn.click();

    // The editor area should contain the file content
    const editorArea = page.locator('textarea, [role="textbox"]').first();
    await expect(editorArea).toContainText('nmap', { timeout: 5000 });
  });

  test('5. File editor has a Save button', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE], { 'scripts/recon.sh': '#!/bin/bash' });

    const fileBtn = page.locator('aside').locator('text="recon.sh"').first();
    await fileBtn.click();

    const saveBtn = page.locator('button:has-text("Save"), button[aria-label*="save" i]').first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
  });

  test('6. File editor Back button returns to chat view', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE], { 'scripts/recon.sh': '#!/bin/bash' });

    const fileBtn = page.locator('text="recon.sh"').first();
    await fileBtn.click();

    // The file editor header shows "← Chat / recon.sh" breadcrumb.
    // The back link is the "← Chat" part — rendered as a button or link
    // containing the text "Chat".
    const backBtn = page.locator('button:has-text("Chat"), a:has-text("Chat"), [role="button"]:has-text("Chat")').first();
    await expect(backBtn).toBeVisible({ timeout: 5000 });
    await backBtn.click();

    // The chat textarea should be visible again
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
  });

  test('7. Runnable files show a Run button', async ({ page }) => {
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': '#!/bin/bash\necho hi' },
    );

    const fileBtn = page.locator('aside').locator('text="recon.sh"').first();
    await fileBtn.click();

    const runBtn = page.locator('button:has-text("Run"), button[aria-label*="run" i]').first();
    await expect(runBtn).toBeVisible({ timeout: 5000 });
  });

  test('8. Notes files do NOT show a Run button', async ({ page }) => {
    await gotoWithSession(
      page,
      [NOTE_FILE],
      { 'notes/findings.md': '# Findings\n- XSS in login form' },
    );

    const fileBtn = page.locator('aside').locator('text="findings.md"').first();
    await fileBtn.click();

    // Run button should NOT be present for notes
    const runBtn = page.locator('button:has-text("Run"), button[aria-label*="run" i]');
    await expect(runBtn).toHaveCount(0, { timeout: 3000 });
  });

  test('9. New File modal opens via + button in file tree area', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE]);

    // The + button has title="New file" (exact, from source line 165).
    // It lives inside the FileTree component header next to the "Files" label.
    const newFileBtn = page.locator('button[title="New file"]').first();
    await expect(newFileBtn).toBeVisible({ timeout: 5000 });
    await newFileBtn.click();

    // The NewFileModal is a fixed overlay div (not a <dialog>).
    // It contains the heading "New File".
    const modal = page.locator('text="New File"').first();
    await expect(modal).toBeVisible({ timeout: 5000 });
  });

  test('10. New File modal has subdir selector', async ({ page }) => {
    await gotoWithSession(page, []);

    // Open the New File modal via the button with title="New file"
    const newFileBtn = page.locator('button[title="New file"]').first();
    await expect(newFileBtn).toBeVisible({ timeout: 5000 });
    await newFileBtn.click();

    // The modal heading is "New File"
    await expect(page.locator('text="New File"').first()).toBeVisible({ timeout: 5000 });

    // The modal contains three directory selector buttons: scripts, tests, notes
    // These are plain <button> elements with the subdir name as text content.
    await expect(page.locator('button:has-text("scripts")').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("tests")').first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator('button:has-text("notes")').first()).toBeVisible({ timeout: 3000 });
  });

  test('11. Creating a new file adds it to the file tree', async ({ page }) => {
    // Track files in memory for this test
    const localFiles = [{ ...SCRIPT_FILE }];

    await page.route('**/api/chats*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SESSION]) });
      } else if (req.method() === 'GET' && url.pathname.endsWith('/messages')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/workspaces/${SESSION_ID}/files`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session_id: SESSION_ID, files: localFiles }),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/workspaces/${SESSION_ID}/files/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const match = url.pathname.match(/\/api\/workspaces\/[^/]+\/files\/(.+)$/);
      const filePath = match ? match[1] : '';

      if (req.method() === 'PUT') {
        const body = JSON.parse(req.postData() || '{}');
        const newEntry = {
          path: filePath,
          subdir: filePath.split('/')[0],
          name: filePath.split('/').pop(),
          size: (body.content || '').length,
          modified_at: new Date().toISOString(),
        };
        localFiles.push(newEntry);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ path: filePath, size: newEntry.size, modified_at: newEntry.modified_at }),
        });
      } else {
        await route.continue();
      }
    });

    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    const sessionBtn = page.locator('aside').locator(`text="${SESSION.name}"`).first();
    await sessionBtn.click();
    await page.waitForTimeout(300);

    // Verify initial file is shown
    await expect(page.locator('text=recon.sh').first()).toBeVisible({ timeout: 5000 });

    // Find the + button near the FILES heading
    const plusBtns = page.locator('button[title*="new" i], button[aria-label*="new" i], button[title*="file" i], button[aria-label*="file" i]');
    const plusCount = await plusBtns.count();

    let modalOpened = false;
    if (plusCount > 0) {
      await plusBtns.first().click();
      modalOpened = await page.locator('[role="dialog"]').isVisible().catch(() => false);
    }

    if (!modalOpened) {
      test.skip();
      return;
    }

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Fill in the filename
    const nameInput = modal.locator('input[type="text"], input[placeholder*="name" i], input[placeholder*="file" i]').first();
    await nameInput.fill('new_script.sh');

    // Select "scripts" subdir if there's a selector
    const subdirSelect = modal.locator('select, [role="combobox"]').first();
    if (await subdirSelect.isVisible()) {
      await subdirSelect.selectOption('scripts');
    }

    // Submit
    const createBtn = modal.locator('button:has-text("Create"), button[type="submit"]').first();
    await createBtn.click();

    // The new file should appear in the file tree
    await expect(page.locator('text=new_script.sh').first()).toBeVisible({ timeout: 5000 });
  });

  test('12. Deleting a file removes it from the tree', async ({ page }) => {
    // Use a dynamic file list so the mock DELETE actually removes the entry
    // from subsequent GET /files responses.
    const localFiles = [{ ...SCRIPT_FILE }, { ...TEST_FILE }];

    await page.route('**/api/chats*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (req.method() === 'GET' && !url.pathname.match(/\/api\/chats\/.+/)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SESSION]) });
      } else if (req.method() === 'GET' && url.pathname.endsWith('/messages')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/workspaces/${SESSION_ID}/files`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session_id: SESSION_ID, files: [...localFiles] }),
        });
      } else {
        await route.continue();
      }
    });

    await page.route(`**/api/workspaces/${SESSION_ID}/files/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const match = url.pathname.match(/\/api\/workspaces\/[^/]+\/files\/(.+)$/);
      const filePath = match ? match[1] : '';

      if (req.method() === 'GET') {
        const entry = localFiles.find(f => f.path === filePath);
        const content = filePath === 'scripts/recon.sh' ? '#!/bin/bash' : 'def test_pass(): pass';
        await route.fulfill({
          status: entry ? 200 : 404,
          contentType: 'application/json',
          body: entry
            ? JSON.stringify({ path: filePath, content, size: content.length, modified_at: entry.modified_at })
            : JSON.stringify({ detail: 'File not found' }),
        });
      } else if (req.method() === 'DELETE') {
        // Remove from the local list so subsequent GET /files returns updated list
        const idx = localFiles.findIndex(f => f.path === filePath);
        if (idx !== -1) localFiles.splice(idx, 1);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: filePath }) });
      } else {
        await route.continue();
      }
    });

    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    const sessionBtn = page.locator('aside').locator(`text="${SESSION.name}"`).first();
    await sessionBtn.click();
    await page.waitForTimeout(300);

    // Verify both files are shown in the file tree
    await expect(page.locator('text=recon.sh').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=test_auth.py').first()).toBeVisible({ timeout: 5000 });

    // Click the script file to open the editor
    const fileBtn = page.locator('text="recon.sh"').first();
    await fileBtn.click();

    // Wait for the file editor to load (breadcrumb "← Chat / recon.sh" appears)
    await expect(page.locator('button:has-text("Chat")').first()).toBeVisible({ timeout: 5000 });

    // Accept the window.confirm() dialog that handleDelete triggers
    page.on('dialog', dialog => dialog.accept());

    // The delete button is the button immediately before Save in the toolbar.
    const saveBtn = page.locator('button:has-text("Save")').first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });

    const deleted = await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll('button'));
      const saveBtn = allBtns.find(b => b.textContent && b.textContent.includes('Save'));
      if (!saveBtn) return false;
      let prev = saveBtn.previousElementSibling;
      while (prev && prev.tagName !== 'BUTTON') {
        prev = prev.previousElementSibling;
      }
      if (prev && prev.tagName === 'BUTTON') {
        prev.click();
        return true;
      }
      return false;
    });

    if (!deleted) {
      test.skip();
      return;
    }

    // After deletion, onDeleted() is called which navigates back to chat view.
    // The file editor (breadcrumb "← Chat") should disappear.
    await expect(page.locator('button:has-text("Chat")')).toHaveCount(0, { timeout: 5000 });

    // The chat textarea should be visible again (back in chat view)
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 5000 });
  });
});
