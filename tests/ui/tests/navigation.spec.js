/**
 * navigation.spec.js
 *
 * Tests that each sidebar nav link navigates to the correct page.
 *
 * Checks:
 *   1. Root / redirects to /history.
 *   2. Each nav link changes the URL to the expected path.
 *   3. The active nav item has a visually distinct style (orange text class).
 */

import { test, expect } from './fixtures.js';

const NAV_ITEMS = [
  { label: 'History',   href: '/history' },
  { label: 'Findings',  href: '/findings' },
  { label: 'Repeater',  href: '/repeater' },
  { label: 'Proxy',     href: '/proxy' },
  { label: 'Projects',  href: '/projects' },
  { label: 'Settings',  href: '/settings' },
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

  test('active nav item has orange styling', async ({ page }) => {
    // Navigate to /projects
    await page.goto('/projects', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });

    // The active link should have text-orange-500 class applied
    const activeLink = page.locator('aside nav a[href="/projects"]');
    await expect(activeLink).toBeVisible({ timeout: 5000 });

    // Check it has an orange colour class (text-orange-500 or similar)
    const className = await activeLink.getAttribute('class');
    expect(className).toMatch(/orange/);
  });
});
