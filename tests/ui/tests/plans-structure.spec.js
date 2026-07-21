/**
 * plans-structure.spec.js
 *
 * Structural smoke tests for the /plans page.
 *
 * Checks:
 *  1.  "Plans" heading is visible.
 *  2.  Tool filter tabs are present (All, Hunts, Gnaw, Pounce, Snare).
 *  3.  "New Plan" button is present.
 *  4.  With seeded plans: a plan card renders with name, tool badge, and "built-in" label.
 *  5.  Clone button is present on built-in plan cards.
 *  6.  Clicking "New Plan" opens the PlanModal.
 *  7.  PlanModal has Name, Tool selector, Prompt textarea, and Max Tool Calls fields.
 *  8.  Saving with an empty name shows a validation error.
 *  9.  Escape key closes the modal.
 * 10.  Clicking a tool tab filters the plan list (non-matching plans hidden).
 */

import { test, expect } from './fixtures.js';

// ── Seeded plan data ──────────────────────────────────────────────────────────

const BUILTIN_PLAN = {
  id: 'plan-builtin-001',
  name: 'OWASP Top 10 Hunt',
  description: 'Runs a comprehensive OWASP Top 10 scan against the target.',
  tool: 'hunt',
  prompt: 'You are a security researcher...',
  max_tool_calls: 20,
  is_builtin: true,
  created_at: '2024-01-01T00:00:00Z',
};

const CUSTOM_PLAN = {
  id: 'plan-custom-001',
  name: 'Custom Gnaw Plan',
  description: 'A custom gnaw plan.',
  tool: 'gnaw',
  prompt: 'Replay and fuzz the following request...',
  max_tool_calls: 10,
  is_builtin: false,
  created_at: '2024-06-01T00:00:00Z',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gotoWithPlans(page, plans = []) {
  await page.route('**/api/plans**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(plans),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto('/plans', { waitUntil: 'domcontentloaded' });
  // Wait for the Plans page header button to be visible and interactive
  await page.locator('button:has-text("New Plan")').first().waitFor({ state: 'visible', timeout: 10000 });
  // Small settle delay to ensure React event handlers are attached
  await page.waitForTimeout(300);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Plans page — structure', () => {
  test('1. "Plans" heading is visible', async ({ page }) => {
    await gotoWithPlans(page, []);
    // The Plans page header uses a <span> not <h1>
    const heading = page.locator('text=Plans').first();
    await expect(heading).toBeVisible({ timeout: 5000 });
  });

  test('2. Tool filter tabs are present', async ({ page }) => {
    await gotoWithPlans(page, []);
    const expectedTabs = ['All', 'Hunts', 'Gnaw', 'Pounce', 'Snare'];
    for (const tab of expectedTabs) {
      const btn = page.locator(`button:has-text("${tab}")`).first();
      await expect(btn).toBeVisible({ timeout: 5000 });
    }
  });

  test('3. "New Plan" button is present', async ({ page }) => {
    await gotoWithPlans(page, []);
    const btn = page.locator('button:has-text("New Plan")');
    await expect(btn).toBeVisible({ timeout: 5000 });
  });

  test('4. Built-in plan card renders with name, tool badge, and "built-in" label', async ({ page }) => {
    await gotoWithPlans(page, [BUILTIN_PLAN]);

    await expect(page.locator(`text="${BUILTIN_PLAN.name}"`).first()).toBeVisible({ timeout: 5000 });
    // Tool badge (e.g. "hunt")
    await expect(page.locator('text=hunt').first()).toBeVisible({ timeout: 5000 });
    // built-in label
    await expect(page.locator('text=built-in').first()).toBeVisible({ timeout: 5000 });
  });

  test('5. Clone button is present on built-in plan cards', async ({ page }) => {
    await gotoWithPlans(page, [BUILTIN_PLAN]);

    // Built-in plans show a Clone button instead of Edit/Delete
    const cloneBtn = page.locator('button[title="Clone to edit"], button:has-text("Clone")').first();
    await expect(cloneBtn).toBeVisible({ timeout: 5000 });
  });

  test('6. Clicking "New Plan" opens the PlanModal', async ({ page }) => {
    await gotoWithPlans(page, []);

    const newPlanBtn = page.locator('button:has-text("New Plan")').first();
    await expect(newPlanBtn).toBeVisible({ timeout: 5000 });
    await newPlanBtn.click();

    // Modal header should say "New Plan"
    const modalHeader = page.locator('h2:has-text("New Plan")');
    await expect(modalHeader).toBeVisible({ timeout: 10000 });
  });

  test('7. PlanModal has required fields', async ({ page }) => {
    await gotoWithPlans(page, []);
    const newPlanBtn = page.locator('button:has-text("New Plan")').first();
    await expect(newPlanBtn).toBeVisible({ timeout: 5000 });
    await newPlanBtn.click();

    // Wait for modal to open
    const modal = page.locator('h2:has-text("New Plan")');
    await expect(modal).toBeVisible({ timeout: 10000 });

    // Name input
    await expect(page.locator('input[placeholder*="OWASP"]')).toBeVisible({ timeout: 5000 });
    // Tool selector (scoped to modal body)
    await expect(page.locator('select').first()).toBeVisible({ timeout: 5000 });
    // Prompt textarea
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
    // Max Tool Calls number input
    await expect(page.locator('input[type="number"]')).toBeVisible({ timeout: 5000 });
  });

  test('8. Saving with empty name shows validation error', async ({ page }) => {
    await gotoWithPlans(page, []);
    await page.locator('button:has-text("New Plan")').click();

    // Click Save without filling in a name
    await page.locator('button:has-text("Save Plan")').click();

    // Error message should appear
    const error = page.locator('text=Name is required').first();
    await expect(error).toBeVisible({ timeout: 5000 });
  });

  test('9. Escape key closes the PlanModal', async ({ page }) => {
    await gotoWithPlans(page, []);
    const newPlanBtn = page.locator('button:has-text("New Plan")').first();
    await expect(newPlanBtn).toBeVisible({ timeout: 5000 });
    await newPlanBtn.click();

    // Confirm modal is open
    await expect(page.locator('h2:has-text("New Plan")')).toBeVisible({ timeout: 10000 });

    // Press Escape
    await page.keyboard.press('Escape');

    // Modal should be gone
    await expect(page.locator('h2:has-text("New Plan")')).toBeHidden({ timeout: 3000 });
  });

  test('10. Clicking a tool tab filters the plan list', async ({ page }) => {
    await gotoWithPlans(page, [BUILTIN_PLAN, CUSTOM_PLAN]);

    // Both plans visible initially (All tab)
    await expect(page.locator(`text="${BUILTIN_PLAN.name}"`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text="${CUSTOM_PLAN.name}"`).first()).toBeVisible({ timeout: 5000 });

    // Click "Gnaw" tab — only the gnaw plan should be visible
    await page.locator('button:has-text("Gnaw")').first().click();

    await expect(page.locator(`text="${CUSTOM_PLAN.name}"`).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`text="${BUILTIN_PLAN.name}"`)).toBeHidden({ timeout: 3000 });
  });
});
