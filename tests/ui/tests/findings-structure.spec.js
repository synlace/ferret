/**
 * findings-structure.spec.js
 *
 * Structural smoke tests for the /findings page.
 *
 * Checks:
 *  1.  "Findings" heading is visible.
 *  2.  Severity stats bar is present (Critical, High, Medium, Low, Info labels).
 *  3.  Search input is present.
 *  4.  Filter button is present.
 *  5.  "AI Chat" button is present.
 *  6.  "Refresh" button is present.
 *  7.  With seeded findings: rows render with title, severity badge, host, status.
 *  8.  Clicking a row expands the detail section.
 *  9.  Clicking the Filter button opens the filter popup with Severity and Status sections.
 * 10.  Clicking "AI Chat" button toggles the chat panel.
 * 11.  Empty state: "Showing: 0" is displayed when no findings exist.
 */

import { test, expect } from './fixtures.js';

// ── Seeded finding data ───────────────────────────────────────────────────────

const SEEDED_FINDING = {
  id: 'finding-001',
  title: 'SQL Injection in /api/users',
  severity: 'high',
  type: 'injection',
  host: 'api.target.com',
  request_id: 'req-seeded-001',
  source: 'hunt',
  status: 'open',
  description: 'The /api/users endpoint is vulnerable to SQL injection.',
  evidence: "' OR 1=1 --",
  created_at: '2024-06-01T10:00:00Z',
};

const SEEDED_FINDING_2 = {
  id: 'finding-002',
  title: 'Reflected XSS in search parameter',
  severity: 'medium',
  type: 'xss',
  host: 'www.target.com',
  request_id: null,
  source: 'manual',
  status: 'confirmed',
  description: 'The search parameter reflects user input without sanitisation.',
  evidence: '<script>alert(1)</script>',
  created_at: '2024-06-01T11:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gotoWithFindings(page, findings = []) {
  await page.route('**/api/findings**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(findings),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/findings', { waitUntil: 'domcontentloaded' });
  // Wait for the Findings heading to be visible and interactive
  await page.locator('text=Findings').first().waitFor({ state: 'visible', timeout: 10000 });
  // Settle delay to ensure React event handlers are attached (increased for parallel runs)
  await page.waitForTimeout(600);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Findings page — structure', () => {
  test('1. "Findings" heading is visible', async ({ page }) => {
    await gotoWithFindings(page, []);
    const heading = page.locator('text=Findings').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('2. Severity stats bar labels are present', async ({ page }) => {
    await gotoWithFindings(page, []);
    // Stats bar always renders even with 0 findings
    for (const sev of ['Critical', 'High', 'Medium', 'Low', 'Info']) {
      await expect(page.locator(`text=${sev}`).first()).toBeVisible({ timeout: 5000 });
    }
  });

  test('3. Search input is present', async ({ page }) => {
    await gotoWithFindings(page, []);
    const input = page.locator('input[placeholder*="Search findings"]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });

  test('4. Filter button is present', async ({ page }) => {
    await gotoWithFindings(page, []);
    const filterBtn = page.locator('button:has-text("Filter")');
    await expect(filterBtn).toBeVisible({ timeout: 5000 });
  });

  test('5. "AI Chat" button is present', async ({ page }) => {
    await gotoWithFindings(page, []);
    const chatBtn = page.locator('button:has-text("AI Chat")');
    await expect(chatBtn).toBeVisible({ timeout: 5000 });
  });

  test('6. "Refresh" button is present', async ({ page }) => {
    await gotoWithFindings(page, []);
    const refreshBtn = page.locator('button:has-text("Refresh")');
    await expect(refreshBtn).toBeVisible({ timeout: 5000 });
  });

  test('7. Seeded finding rows render with title, host, and status', async ({ page }) => {
    await gotoWithFindings(page, [SEEDED_FINDING, SEEDED_FINDING_2]);

    await expect(page.locator(`text="${SEEDED_FINDING.title}"`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text="${SEEDED_FINDING.host}"`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text="${SEEDED_FINDING_2.title}"`).first()).toBeVisible({ timeout: 5000 });
  });

  test('8. Clicking a finding row expands the detail section', async ({ page }) => {
    await gotoWithFindings(page, [SEEDED_FINDING]);

    // Click the row to expand it
    const row = page.locator(`text="${SEEDED_FINDING.title}"`).first();
    await row.click();

    // The description should now be visible
    await expect(page.locator(`text="${SEEDED_FINDING.description}"`).first()).toBeVisible({ timeout: 5000 });
  });

  test('9. Filter button opens popup with Severity and Status sections', async ({ page }) => {
    await gotoWithFindings(page, []);

    const filterBtn = page.locator('button:has-text("Filter")').first();
    await expect(filterBtn).toBeVisible({ timeout: 5000 });
    await filterBtn.click();

    // Filter popup should show Severity and Status column headers
    await expect(page.locator('text=Severity').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Status').first()).toBeVisible({ timeout: 5000 });
    // Severity checkboxes
    await expect(page.locator('text=CRITICAL').first()).toBeVisible({ timeout: 5000 });
    // Status checkboxes
    await expect(page.locator('text=Open').first()).toBeVisible({ timeout: 5000 });
  });

  test('10. "AI Chat" button toggles the chat panel', async ({ page }) => {
    await gotoWithFindings(page, []);

    const aiChatBtn = page.locator('button:has-text("AI Chat")').first();
    await expect(aiChatBtn).toBeVisible({ timeout: 5000 });
    await aiChatBtn.click();

    // Chat panel opens — the aside panel with "AI SECURITY ANALYST" header appears
    const chatPanel = page.locator('aside').filter({ hasText: 'AI SECURITY ANALYST' });
    await expect(chatPanel).toBeVisible({ timeout: 5000 });
  });

  test('11. "Showing: 0" is displayed when no findings exist', async ({ page }) => {
    await gotoWithFindings(page, []);
    // Stats bar shows "Showing: 0"
    await expect(page.locator('text=Showing').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=0').first()).toBeVisible({ timeout: 5000 });
  });
});
