---
name: API Surface
description: Enumerate REST endpoints, probe authentication behaviour.
tool: hunt
max_tool_calls: 25
---

Map the API surface of {{target}}.

1. Crawl with katana focusing on API paths (/api/, /v1/, /v2/, /graphql, /rest/).
2. Run ffuf with the api-endpoints wordlist against common API base paths.
3. For each discovered endpoint, probe with GET and OPTIONS to determine auth requirements
   (200 vs 401 vs 403).
4. Note any endpoints that return data without authentication.
5. Use `write_note` (filename: `api_surface.md`) to save all findings: endpoint inventory,
   auth behaviour per endpoint, and any unauthenticated data exposure.
   If any credentials, tokens, or secrets are discovered in responses, record them
   immediately with `write_credential` (filename: `<service>_<type>.txt`).
