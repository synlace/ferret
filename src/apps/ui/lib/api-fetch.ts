/**
 * Thin wrapper around the browser Fetch API that always includes credentials
 * (session cookies) so the ferret_session cookie is sent on every request to
 * the API, even when the UI (port 3000) and API (port 8000) are on different
 * ports (which browsers treat as different origins).
 *
 * Usage:
 *   import { apiFetch } from "@/lib/api-fetch"
 *   const res = await apiFetch(`${API_BASE}/api/requests`)
 *
 * All standard fetch options are forwarded; `credentials` defaults to
 * "include" but can be overridden if needed.
 */
export function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetch(input, { credentials: "include", ...init })
}
