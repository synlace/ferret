/**
 * projects-structure.spec.js
 *
 * Smoke tests for the Projects page DOM structure.
 *
 * Checks:
 *   1. "Projects" heading is visible.
 *   2. "New Project" button is present.
 *   3. The projects table is rendered with column headers.
 *   4. The temp project row is visible (mock returns one temp project).
 *   5. Search input is present.
 */

import { test, expect } from './fixtures.js';

test.describe('Projects page — structure', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    // Wait for the page heading to appear
    await page.waitForSelector('h1', { timeout: 10000 });
  });

  test('"Projects" heading is visible', async ({ page }) => {
    // The projects page renders a heading or table header
    const heading = page.locator('h1, h2').filter({ hasText: /project/i }).first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('"New Project" button is present', async ({ page }) => {
    const btn = page.locator('button:has-text("New Project")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('projects table is rendered', async ({ page }) => {
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 5000 });
  });

  test('table has column headers', async ({ page }) => {
    // Expect at least a "Name" column header
    const nameHeader = page.locator('th:has-text("Name")');
    await expect(nameHeader).toBeVisible({ timeout: 5000 });
  });

  test('at least one project row is visible', async ({ page }) => {
    // Mock returns one project (Temp Workspace). The context loads asynchronously;
    // wait for the "No projects yet" empty state to disappear and a real row to appear.
    // The empty state cell has colSpan=8; a real row has individual <td> cells.
    await expect(page.locator('tbody td[colspan]')).toHaveCount(0, { timeout: 10000 });
    await expect(page.locator('tbody tr')).toHaveCount(1, { timeout: 5000 });
  });

  test('filter input is present', async ({ page }) => {
    // The projects page uses "Filter projects…" as the placeholder
    const input = page.locator('input[placeholder="Filter projects…"]');
    await expect(input).toBeVisible({ timeout: 5000 });
  });
});
