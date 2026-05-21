/**
 * mock-server-contract.cjs
 *
 * Authoritative definition of the FERRET API surface that the UI depends on.
 *
 * This file is the single source of truth for:
 *   - Which endpoints the UI calls
 *   - What HTTP method and status code each returns
 *   - Which fields are required in each response
 *
 * When any API endpoint changes (new field, renamed field, new endpoint,
 * changed status code):
 *   1. Update this file first.
 *   2. Update mock-server-handlers.cjs to match.
 *   3. Update UI code if field names changed.
 *
 * Never update mock-server-handlers.cjs directly without going through
 * this contract file first.
 */

'use strict';

/**
 * CONTRACT — each entry describes one endpoint the UI depends on.
 *
 * Fields:
 *   method        HTTP method (uppercase)
 *   path          URL path (exact match)
 *   status        Expected HTTP status code
 *   contentType   Expected Content-Type prefix
 *   requiredFields  Top-level fields that must be present in the response body
 *                   (for array responses, checked on the first element if present)
 *   fixedValues   Key/value pairs that must match exactly in the response body
 */
const CONTRACT = [
  // ── Health ──────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/health',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['status'],
    fixedValues: { status: 'ok' },
  },

  // ── Auth ─────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/auth/me',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['authenticated'],
    fixedValues: {},
  },

  // ── Setup ────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/setup',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['setup_complete'],
    fixedValues: { setup_complete: true },
  },

  // ── Proxy ───────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/proxy/status',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['running', 'uptime', 'listen_address', 'intercepted'],
    fixedValues: {},
  },

  // ── Projects ─────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/projects',
    status: 200,
    contentType: 'application/json',
    // Array response — required fields checked on first element
    requiredFields: ['id', 'name', 'is_temp'],
    fixedValues: {},
  },

  // ── Requests ─────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/requests',
    status: 200,
    contentType: 'application/json',
    // Array response — may be empty; header X-Total-Count must be present
    requiredFields: [],
    fixedValues: {},
    requiredHeaders: ['x-total-count'],
  },

  // ── Findings ─────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/findings',
    status: 200,
    contentType: 'application/json',
    requiredFields: [],
    fixedValues: {},
  },

  // ── Plans ────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/plans',
    status: 200,
    contentType: 'application/json',
    // Array response — may be empty
    requiredFields: [],
    fixedValues: {},
  },

  {
    method: 'POST',
    path: '/api/plans',
    status: 201,
    contentType: 'application/json',
    requiredFields: ['id', 'name', 'tool', 'prompt', 'max_tool_calls', 'is_builtin', 'created_at'],
    fixedValues: {},
  },

  // ── Settings / CA cert ───────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/ca-cert',
    status: 200,
    contentType: 'application/x-pem-file',
    requiredFields: [],
    fixedValues: {},
  },

  // ── Chats ────────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/chats',
    status: 200,
    contentType: 'application/json',
    // Array response — may be empty
    requiredFields: [],
    fixedValues: {},
  },

  {
    method: 'POST',
    path: '/api/chats',
    status: 201,
    contentType: 'application/json',
    requiredFields: ['id', 'name', 'scope', 'created_at', 'workspace_dir'],
    fixedValues: {},
  },

  // ── Workspaces ───────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/hunts/session-seeded-001/files',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['session_id', 'files'],
    fixedValues: { session_id: 'session-seeded-001' },
  },

  {
    method: 'PUT',
    path: '/api/hunts/session-seeded-001/files/scripts/run.sh',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['path', 'size', 'modified_at'],
    fixedValues: { path: 'scripts/run.sh' },
  },

  {
    method: 'GET',
    path: '/api/hunts/session-seeded-001/files/scripts/run.sh',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['path', 'content', 'size', 'modified_at'],
    fixedValues: { path: 'scripts/run.sh' },
  },

  {
    method: 'DELETE',
    path: '/api/hunts/session-seeded-001/files/scripts/run.sh',
    status: 200,
    contentType: 'application/json',
    requiredFields: ['deleted'],
    fixedValues: { deleted: 'scripts/run.sh' },
  },

  // ── Gnaw tabs ────────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/gnaw/tabs',
    status: 200,
    contentType: 'application/json',
    // Array response — may be empty
    requiredFields: [],
    fixedValues: {},
  },

  {
    method: 'POST',
    path: '/api/gnaw/tabs',
    status: 201,
    contentType: 'application/json',
    requiredFields: ['id', 'label', 'position', 'created_at'],
    fixedValues: {},
  },

  // ── Snare rules ──────────────────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/snare/rules',
    status: 200,
    contentType: 'application/json',
    // Array response — may be empty
    requiredFields: [],
    fixedValues: {},
  },

  {
    method: 'POST',
    path: '/api/snare/rules',
    status: 201,
    contentType: 'application/json',
    requiredFields: ['id', 'name', 'enabled'],
    fixedValues: {},
  },

  // ── Snare intercepted queue ───────────────────────────────────────────────────
  {
    method: 'GET',
    path: '/api/snare/intercepted',
    status: 200,
    contentType: 'application/json',
    requiredFields: [],
    fixedValues: {},
  },
];

module.exports = { CONTRACT };
