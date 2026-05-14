/**
 * app-shell.spec.js
 *
 * Smoke tests for the FERRET app shell (sidebar) DOM structure.
 *
 * Checks:
 *   1. FERRET branding ("FERRET" heading) is visible in the sidebar.
 *   2. Version/subtitle text is present.
 *   3. All 9 nav items are rendered.
 *   4. The collapse/expand toggle button is present.
 *   5. Sidebar collapses when the toggle is clicked.
 *   6. Sidebar expands again when the toggle is clicked a second time.
 *   7. ProjectSwitcher is rendered inside the sidebar.
 */

import { test, expect } from './fixtures.js';

test.describe('App shell — sidebar structure', () => {
  test('FERRET branding is visible', async ({ page }) => {
    const heading = page.locator('aside h1');
    await expect(heading).toBeVisible({ timeout: 5000 });
    await expect(heading).toHaveText('FERRET');
  });

  test('version subtitle is visible', async ({ page }) => {
    // "v2.0 MITM PROXY" subtitle
    const subtitle = page.locator('aside p').first();
    await expect(subtitle).toBeVisible({ timeout: 5000 });
    await expect(subtitle).toContainText('MITM PROXY');
  });

  test('sidebar contains all 8 nav items', async ({ page }) => {
    // After the Workspaces rebrand, Chat and Tests were merged into Workspaces,
    // so the nav has 8 items instead of 9.
    const navLinks = page.locator('aside nav a');
    await expect(navLinks).toHaveCount(8, { timeout: 5000 });
  });

  test('nav items include expected labels', async ({ page }) => {
    // Chat and Tests are now merged into Workspaces.
    const expectedLabels = [
      'History', 'Findings', 'Workspaces',
      'Intercept', 'Repeater', 'Proxy', 'Projects', 'Settings',
    ];
    for (const label of expectedLabels) {
      const link = page.locator(`aside nav a:has-text("${label}")`);
      await expect(link).toBeVisible({ timeout: 5000 });
    }
  });

  test('collapse toggle button is present', async ({ page }) => {
    // Use the specific title to avoid matching the project switcher button
    const toggle = page.locator('aside button[title="Collapse sidebar"]');
    await expect(toggle).toBeVisible({ timeout: 5000 });
  });

  test('sidebar collapses when toggle is clicked', async ({ page }) => {
    const toggle = page.locator('aside button[title="Collapse sidebar"]');
    await toggle.click();

    // After collapse, the FERRET heading should be hidden
    const heading = page.locator('aside h1');
    await expect(heading).toBeHidden({ timeout: 3000 });
  });

  test('sidebar expands again after second toggle click', async ({ page }) => {
    // Collapse first
    const collapseBtn = page.locator('aside button[title="Collapse sidebar"]');
    await collapseBtn.click();
    await expect(page.locator('aside h1')).toBeHidden({ timeout: 3000 });

    // Expand — button title changes to "Expand sidebar" after collapse
    const expandBtn = page.locator('aside button[title="Expand sidebar"]');
    await expandBtn.click();
    await expect(page.locator('aside h1')).toBeVisible({ timeout: 3000 });
  });
});
