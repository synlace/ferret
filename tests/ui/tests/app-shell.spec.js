/**
 * app-shell.spec.js
 *
 * Smoke tests for the Ferret app shell (sidebar) DOM structure.
 *
 * Checks:
 *   1. Ferret branding ("Ferret" heading) is visible in the sidebar.
 *   2. "by Synlace" subtitle link is present.
 *   3. All 9 nav items are rendered.
 *   4. Nav items include the expected labels.
 *   5. The collapse/expand toggle button is present.
 *   6. Sidebar collapses when the toggle is clicked.
 *   7. Sidebar expands again when the toggle is clicked a second time.
 */

import { test, expect } from './fixtures.js';

test.describe('App shell — sidebar structure', () => {
  test('Ferret branding is visible', async ({ page }) => {
    const heading = page.locator('aside h1');
    await expect(heading).toBeVisible({ timeout: 5000 });
    await expect(heading).toContainText('Ferret');
  });

  test('"by Synlace" subtitle is visible', async ({ page }) => {
    // The sidebar header contains an "by Synlace" link below the Ferret heading.
    const subtitle = page.locator('aside a:has-text("by Synlace")');
    await expect(subtitle).toBeVisible({ timeout: 5000 });
  });

  test('sidebar contains all 12 nav items', async ({ page }) => {
    // Current navItems: History, Snare, Gnaw, Pounce, Plans, Workspaces, Runs, Hunts, Findings, Projects, Logs, Settings
    const navLinks = page.locator('aside nav a');
    await expect(navLinks).toHaveCount(12, { timeout: 5000 });
  });

  test('nav items include expected labels', async ({ page }) => {
    // Current nav as defined in app-shell.tsx navItems array.
    const expectedLabels = [
      'History', 'Snare', 'Gnaw', 'Pounce', 'Plans',
      'Workspaces', 'Runs', 'Hunts', 'Findings', 'Projects', 'Logs', 'Settings',
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

    // After collapse, the Ferret heading should be hidden (opacity-0 / pointer-events-none)
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

  test('"Latest News" bell button is present in sidebar', async ({ page }) => {
    const bell = page.locator('aside button[title="Latest News"]');
    await expect(bell).toBeVisible({ timeout: 5000 });
  });

  test('"Sign out" button is present in sidebar', async ({ page }) => {
    const signOut = page.locator('aside button[title="Sign out"]');
    await expect(signOut).toBeVisible({ timeout: 5000 });
  });

  test('proxy status indicator is present in sidebar', async ({ page }) => {
    // The proxy dot (green/red circle) is always rendered at the bottom of the sidebar.
    // The listen address text is also shown when expanded.
    const proxyDot = page.locator('aside div[title="Proxy active"], aside div[title="Proxy stopped"]');
    await expect(proxyDot).toBeVisible({ timeout: 5000 });
  });
});
