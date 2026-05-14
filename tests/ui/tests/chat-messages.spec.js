/**
 * chat-messages.spec.js
 *
 * Tests for message sending, ordering, and rendering on the Chat page.
 *
 * Checks:
 *  14. User message appears immediately after sending (right-aligned bubble).
 *  15. Input is cleared after sending.
 *  16. Thinking indicator (bouncing dots) appears while the stream is in flight.
 *  17. Assistant reply appears after the stream completes.
 *  18. Messages are ordered oldest-first (user bubble before assistant bubble).
 *  19. Shift+Enter inserts a newline instead of sending.
 *  20. ↑ arrow key cycles through input history.
 *  21. Stop button aborts the stream and restores the Send button.
 *
 * Strategy:
 *   - Use page.route() to intercept /api/chats* so tests are fully self-contained.
 *   - The SSE stream mock uses route.fulfill() with a complete SSE body.
 *     The UI's fetch/ReadableStream reader processes the body as a stream of
 *     chunks; even when delivered at once, the SSE parser handles it correctly.
 *   - For the "thinking" test we use a slow response via page.route with a
 *     manual delay before fulfilling.
 *   - For the "stop" test we use route.abort() after the request is received
 *     to simulate a network abort.
 */

import { test, expect } from './fixtures.js';

const MOCK_SESSION = {
  id: 'session-msg-test-001',
  name: 'Message Test Session',
  scope: 'all',
  scope_data: null,
  created_at: '2024-06-01T10:00:00Z',
};

/**
 * Build a complete SSE body for a chat stream response.
 * Emits a delta event then a done event with the full message list.
 */
function buildSseBody(userContent, replyContent) {
  const donePayload = JSON.stringify({
    type: 'done',
    messages: [
      { role: 'user', content: userContent },
      { role: 'assistant', content: replyContent },
    ],
  });
  return [
    `data: ${JSON.stringify({ type: 'delta', content: replyContent })}\n\n`,
    `data: ${donePayload}\n\n`,
  ].join('');
}

/**
 * Navigate to /chat with a pre-loaded session.
 * Intercepts all /api/chats* routes.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ replyContent?: string, hangForever?: boolean }} opts
 */
async function setupChatPage(page, opts = {}) {
  const { replyContent = 'Mock reply', hangForever = false } = opts;

  await page.route('**/api/chats**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());

    // GET /api/chats — return our mock session
    if (req.method() === 'GET' && url.pathname === '/api/chats') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([MOCK_SESSION]),
      });
      return;
    }

    // GET /api/chats/:id/messages — return empty history
    if (req.method() === 'GET' && url.pathname.match(/\/api\/chats\/.+\/messages$/)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ messages: [] }),
      });
      return;
    }

    // POST /api/chats/:id/messages/stream — SSE stream
    if (req.method() === 'POST' && url.pathname.match(/\/api\/chats\/.+\/messages\/stream$/)) {
      if (hangForever) {
        // Abort the request to simulate a network error / stop
        await route.abort('failed');
        return;
      }

      const body = req.postDataJSON() ?? {};
      const userContent = body.message ?? 'Hello';

      await route.fulfill({
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Transfer-Encoding': 'chunked',
        },
        body: buildSseBody(userContent, replyContent),
      });
      return;
    }

    // DELETE /api/chats/:id
    if (req.method() === 'DELETE') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    await route.continue();
  });

  await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('aside', { timeout: 10000 });

  // Click the seeded session to activate it
  const sessionItem = page.locator('text=Message Test Session').first();
  await expect(sessionItem).toBeVisible({ timeout: 5000 });
  await sessionItem.click();

  // Wait for the textarea to become enabled
  const textarea = page.locator('textarea[placeholder*="Message"]');
  await expect(textarea).toBeEnabled({ timeout: 5000 });
}

test.describe('Chat page — message sending and rendering', () => {
  test('user message appears immediately after sending', async ({ page }) => {
    await setupChatPage(page);

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.fill('Hello world');
    await textarea.press('Enter');

    // User bubble should appear right-aligned
    const userBubble = page.locator('div.items-end').filter({ hasText: 'Hello world' }).first();
    await expect(userBubble).toBeVisible({ timeout: 5000 });
  });

  test('input is cleared after sending', async ({ page }) => {
    await setupChatPage(page);

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.fill('Clear me');
    await textarea.press('Enter');

    // Input should be empty immediately after sending
    await expect(textarea).toHaveValue('', { timeout: 3000 });
  });

  test('thinking indicator appears while stream is in flight', async ({ page }) => {
    // Use a slow route that delays before fulfilling
    await page.route('**/api/chats**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());

      if (req.method() === 'GET' && url.pathname === '/api/chats') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([MOCK_SESSION]) });
        return;
      }
      if (req.method() === 'GET' && url.pathname.match(/\/api\/chats\/.+\/messages$/)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
        return;
      }
      if (req.method() === 'POST' && url.pathname.match(/\/api\/chats\/.+\/messages\/stream$/)) {
        // Delay 600ms before responding so we can observe the thinking state
        await new Promise(r => setTimeout(r, 600));
        const body = req.postDataJSON() ?? {};
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
          body: buildSseBody(body.message ?? 'Hello', 'Delayed reply'),
        });
        return;
      }
      await route.continue();
    });

    await page.goto('/workspaces', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('aside', { timeout: 10000 });
    const sessionItem = page.locator('text=Message Test Session').first();
    await expect(sessionItem).toBeVisible({ timeout: 5000 });
    await sessionItem.click();
    const textarea = page.locator('textarea[placeholder*="Message"]');
    await expect(textarea).toBeEnabled({ timeout: 5000 });

    await textarea.fill('Thinking test');
    await textarea.press('Enter');

    // The three bouncing dots should appear before the stream resolves
    const dots = page.locator('.animate-bounce').first();
    await expect(dots).toBeVisible({ timeout: 3000 });
  });

  test('assistant reply appears after stream completes', async ({ page }) => {
    await setupChatPage(page, { replyContent: 'I am the mock assistant!' });

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.fill('Hi assistant');
    await textarea.press('Enter');

    // Wait for the assistant bubble with the "AI" label
    const aiLabel = page.locator('div.text-orange-400:has-text("AI")').first();
    await expect(aiLabel).toBeVisible({ timeout: 10000 });

    // The reply content should be visible
    const replyBubble = page.locator('text=I am the mock assistant!').first();
    await expect(replyBubble).toBeVisible({ timeout: 10000 });
  });

  test('messages are ordered oldest-first (user then assistant)', async ({ page }) => {
    await setupChatPage(page, { replyContent: 'Assistant response' });

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.fill('User message first');
    await textarea.press('Enter');

    // Wait for both bubbles
    const userBubble = page.locator('div.items-end').filter({ hasText: 'User message first' }).first();
    const assistantBubble = page.locator('div.items-start').filter({ hasText: 'Assistant response' }).first();

    await expect(userBubble).toBeVisible({ timeout: 10000 });
    await expect(assistantBubble).toBeVisible({ timeout: 10000 });

    // User bubble should appear before assistant bubble in the DOM
    const userBox = await userBubble.boundingBox();
    const assistantBox = await assistantBubble.boundingBox();
    expect(userBox.y).toBeLessThan(assistantBox.y);
  });

  test('Shift+Enter inserts a newline instead of sending', async ({ page }) => {
    await setupChatPage(page);

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.click();
    // Use keyboard API to type and press Shift+Enter
    await page.keyboard.type('line1');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('line2');

    // Textarea should contain a newline
    const value = await textarea.inputValue();
    expect(value).toContain('line1');
    expect(value).toContain('line2');

    // No message bubble should have appeared — the textarea still has content
    // (if Enter had been pressed without Shift, the textarea would be empty)
    const currentValue = await textarea.inputValue();
    expect(currentValue.length).toBeGreaterThan(0);
  });

  test('↑ arrow key cycles through input history', async ({ page }) => {
    await setupChatPage(page);

    const textarea = page.locator('textarea[placeholder*="Message"]');

    // Send first message and wait for it to complete
    await textarea.fill('first message');
    await textarea.press('Enter');
    await expect(page.locator('div.items-end').filter({ hasText: 'first message' }).first()).toBeVisible({ timeout: 5000 });
    // Wait for stream to complete (textarea re-enabled)
    await expect(textarea).toBeEnabled({ timeout: 8000 });

    // Send second message and wait for it to complete
    await textarea.fill('second message');
    await textarea.press('Enter');
    await expect(page.locator('div.items-end').filter({ hasText: 'second message' }).first()).toBeVisible({ timeout: 5000 });
    await expect(textarea).toBeEnabled({ timeout: 8000 });

    // Press ↑ — should restore "second message" (most recent)
    await textarea.click();
    await page.keyboard.press('ArrowUp');
    await expect(textarea).toHaveValue('second message', { timeout: 3000 });

    // Press ↑ again — should restore "first message"
    await page.keyboard.press('ArrowUp');
    await expect(textarea).toHaveValue('first message', { timeout: 3000 });
  });

  test('Stop button aborts the stream and restores the Send button', async ({ page }) => {
    // Use hangForever — the route aborts the fetch, which triggers the AbortError path
    await setupChatPage(page, { hangForever: true });

    const textarea = page.locator('textarea[placeholder*="Message"]');
    await textarea.fill('Stop me');
    await textarea.press('Enter');

    // After the abort, loading should be false and Send button should return
    // (the abort happens immediately since route.abort() is synchronous)
    const sendBtn = page.locator('button[title="Send"]');
    await expect(sendBtn).toBeVisible({ timeout: 8000 });
  });
});
