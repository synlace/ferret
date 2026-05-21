/**
 * hunts-files.spec.js
 *
 * Tests for the file list and inline file editor on the /hunts page.
 *
 * The file list is shown inline in the session card (HuntsList) when a session
 * is active and has files. Files are shown as full paths (e.g. "scripts/recon.sh").
 * Clicking a file path opens the FileEditor in the centre panel.
 *
 * Checks:
 *  1.  File list is hidden when no files exist in the hunt session.
 *  2.  File list shows files with their full paths.
 *  3.  Clicking a file path opens the file editor (FileEditor replaces chat).
 *  4.  File editor shows the file content in a CodeMirror editor.
 *  5.  File editor has a Save button.
 *  6.  File editor has a "Chat" breadcrumb button that returns to the chat view.
 *  7.  Runnable files (scripts/*.sh) show a Run button in the editor toolbar.
 *  8.  Notes files do NOT show a Run button.
 */

import { test, expect } from './fixtures.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID = 'session-hunts-files-001';
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

const NOTE_FILE = {
  path: 'notes/findings.md',
  subdir: 'notes',
  name: 'findings.md',
  size: 15,
  modified_at: '2024-06-01T10:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Set up route intercepts and navigate to /hunts with the test session active.
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

  // Stub GET /api/hunts/{id}/files → return provided files
  await page.route(`**/api/hunts/${SESSION_ID}/files`, async (route) => {
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

  // Stub GET/PUT/DELETE /api/hunts/{id}/files/{path}
  await page.route(`**/api/hunts/${SESSION_ID}/files/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const match = url.pathname.match(/\/api\/hunts\/[^/]+\/files\/(.+)$/);
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

  await page.goto('/hunts', { waitUntil: 'domcontentloaded' });
  // Wait for the hunts session list to appear (it's in main, not aside)
  await page.waitForSelector('main', { timeout: 10000 });
  await page.waitForSelector('text="File Tree Test Session"', { timeout: 10000 });

  // Click the session to make it active
  const sessionBtn = page.locator('text="File Tree Test Session"').first();
  await sessionBtn.click();
  await page.waitForTimeout(500);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Hunts page — file list', () => {
  test('1. File list is hidden when hunt has no files', async ({ page }) => {
    await gotoWithSession(page, []);

    // No file paths should be visible in the session card
    const filePaths = page.locator('text="scripts/recon.sh"');
    await expect(filePaths).toHaveCount(0, { timeout: 3000 });
  });

  test('2. File list shows files with their full paths', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE, NOTE_FILE]);

    // Files are shown as full paths in the session card
    await expect(page.locator('text="scripts/recon.sh"').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text="notes/findings.md"').first()).toBeVisible({ timeout: 5000 });
  });

  test('3. Clicking a file path opens the file editor', async ({ page }) => {
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': '#!/bin/bash\nnmap -sV $TARGET' },
    );

    // The chat textarea should be visible initially
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // Click the file path in the session card
    const fileLink = page.locator('text="scripts/recon.sh"').first();
    await fileLink.click();

    // The FileEditor should appear — it shows a CodeMirror editor
    await expect(page.locator('.cm-editor').first()).toBeVisible({ timeout: 5000 });
  });

  test('4. File editor shows the file content', async ({ page }) => {
    const content = '#!/bin/bash\nnmap -sV $TARGET\necho "done"';
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': content },
    );

    const fileLink = page.locator('text="scripts/recon.sh"').first();
    await fileLink.click();

    // CodeMirror renders content in .cm-content
    await expect(page.locator('.cm-content').first()).toContainText('nmap', { timeout: 5000 });
  });

  test('5. File editor has a Save button', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE], { 'scripts/recon.sh': '#!/bin/bash' });

    const fileLink = page.locator('text="scripts/recon.sh"').first();
    await fileLink.click();

    const saveBtn = page.locator('button:has-text("Save")').first();
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
  });

  test('6. File editor "Chat" breadcrumb returns to chat view', async ({ page }) => {
    await gotoWithSession(page, [SCRIPT_FILE], { 'scripts/recon.sh': '#!/bin/bash' });

    const fileLink = page.locator('text="scripts/recon.sh"').first();
    await fileLink.click();

    // The file editor header shows a "Chat" breadcrumb button
    const backBtn = page.locator('button:has-text("Chat")').first();
    await expect(backBtn).toBeVisible({ timeout: 5000 });
    await backBtn.click();

    // The chat textarea should be visible again
    const textarea = page.locator('textarea').first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
  });

  test('7. Runnable files (scripts/*.sh) show a Run button', async ({ page }) => {
    await gotoWithSession(
      page,
      [SCRIPT_FILE],
      { 'scripts/recon.sh': '#!/bin/bash\necho hi' },
    );

    const fileLink = page.locator('text="scripts/recon.sh"').first();
    await fileLink.click();

    const runBtn = page.locator('button:has-text("Run")').first();
    await expect(runBtn).toBeVisible({ timeout: 5000 });
  });

  test('8. Notes files do NOT show a Run button', async ({ page }) => {
    await gotoWithSession(
      page,
      [NOTE_FILE],
      { 'notes/findings.md': '# Findings\n- XSS in login form' },
    );

    const fileLink = page.locator('text="notes/findings.md"').first();
    await fileLink.click();

    // Run button should NOT be present for notes
    const runBtn = page.locator('button:has-text("Run")');
    await expect(runBtn).toHaveCount(0, { timeout: 3000 });
  });
});
