/**
 * mock-server-contract.spec.js
 *
 * Contract validation: verifies that the mock API server honours every
 * endpoint defined in mock-server-contract.cjs.
 *
 * These tests run directly against the mock server (not through the UI),
 * so they are fast and do not require the Next.js dev server to be running.
 *
 * For each CONTRACT entry this spec checks:
 *   - Correct HTTP status code
 *   - Correct Content-Type header
 *   - All required top-level fields are present in the response body
 *   - All fixedValues match exactly
 *   - All requiredHeaders are present in the response
 *
 * Usage:
 *   just test ui          — runs as part of the full suite
 *   npx playwright test tests/mock-server-contract.spec.js  — standalone
 */

import { test, expect } from '@playwright/test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { CONTRACT } = require('../mock-server-contract.cjs');

const MOCK_PORT = parseInt(process.env.FERRET_MOCK_PORT || '18000', 10);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

for (const entry of CONTRACT) {
  const { method, path, status, contentType, requiredFields, fixedValues, requiredHeaders } = entry;

  test(`${method} ${path} → ${status} with correct shape`, async ({ request }) => {
    const response = await request[method.toLowerCase()](
      `${MOCK_BASE}${path}`,
      { failOnStatusCode: false },
    );

    // ── Status code ──────────────────────────────────────────────────────────
    expect(
      response.status(),
      `Expected ${method} ${path} to return ${status}, got ${response.status()}`,
    ).toBe(status);

    // ── Content-Type ─────────────────────────────────────────────────────────
    const ct = response.headers()['content-type'] ?? '';
    expect(
      ct,
      `Expected Content-Type to start with "${contentType}", got "${ct}"`,
    ).toContain(contentType.split(';')[0]);

    // ── Required headers ─────────────────────────────────────────────────────
    if (requiredHeaders && requiredHeaders.length > 0) {
      const headers = response.headers();
      for (const header of requiredHeaders) {
        expect(
          headers[header.toLowerCase()],
          `Expected response header "${header}" to be present`,
        ).toBeDefined();
      }
    }

    // ── Body shape ───────────────────────────────────────────────────────────
    if (requiredFields.length === 0 && Object.keys(fixedValues).length === 0) {
      // No body assertions for this endpoint (e.g. binary/PEM responses)
      return;
    }

    const body = await response.json();

    // For array responses, check the first element if the array is non-empty
    const target = Array.isArray(body) ? body[0] : body;

    if (Array.isArray(body) && body.length === 0) {
      // Empty array is valid — required fields can't be checked
      return;
    }

    // Required fields
    for (const field of requiredFields) {
      expect(
        target,
        `Expected field "${field}" to be present in response from ${method} ${path}`,
      ).toHaveProperty(field);
    }

    // Fixed values
    for (const [key, value] of Object.entries(fixedValues)) {
      expect(
        target[key],
        `Expected ${method} ${path} response.${key} to equal ${JSON.stringify(value)}`,
      ).toBe(value);
    }
  });
}
