/**
 * navigation.spec.js
 *
 * Tests that each sidebar nav link navigates to the correct page.
 *
 * Checks:
 *   1. Root / redirects to /history.
 *   2. Each nav link changes the URL to the expected path.
 *   3. The active nav item has the brand highlight style.
 */

import { test, expect } from './fixtures.js';

// Current navItems from app-shell.tsx (as of 2026-05-21):
//   History, Snare, Gnaw, Pounce, Plans, Hunts, Findings, Projects, Settings
const NAV_ITEMS = [
  { label: 'History',  href: '/history' },
  { label: 'Snare',    href: '/snare' },
  { label: 'Gnaw',     href: '/gnaw' },
  { label: 'Pounce',   href: '/pounce' },
  { label: 'Plans',    href: '/plans' },
  { label: 'Hunts',    href: '/hunts' },
  { label: 'Findings', href: '/findings' },
  { label: 'Projects', href: '/projects' },
  { label: 'Settings', href: '/settings' },
];

test.describe('Navigation', () => {
  test('root / redirects to /history', async ({ page }) => {
    await expect(page).toHaveURL(/\/history/, { timeout: 10000 });
  });

  for (const { label, href } of NAV_ITEMS) {
    test(`clicking "${label}" navigates to ${href}`, async ({ page }) => {
      const link = page.locator(`aside nav a:has-text("${label}")`);
      await link.click();
      await expect(page).toHaveURL(new RegExp(href.replace('/', '\\/')), { timeout: 10000 });
    });
  }

  test('active nav item has brand highlight styling', async ({ page }) => {
    // Navigate to /projects
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    // The active link has bg-brand-500/20 text-brand-400 border-l-brand-500 applied.
    // Check for the "brand" token in the class string.
    const activeLink = page.locator('aside nav a[href="/projects"]');
    await expect(activeLink).toBeVisible({ timeout: 5000 });

    const className = await activeLink.getAttribute('class');
    expect(className).toMatch(/brand/);
  });

  test('inactive nav items do not have brand highlight', async ({ page }) => {
    // On /history, the History link is active; Projects should not be highlighted.
    await page.goto('/history', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    const inactiveLink = page.locator('aside nav a[href="/projects"]');
    await expect(inactiveLink).toBeVisible({ timeout: 5000 });

    const className = await inactiveLink.getAttribute('class');
    // Should NOT have the active background class
    expect(className).not.toMatch(/bg-brand/);
  });
});
