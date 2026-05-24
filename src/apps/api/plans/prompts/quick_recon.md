---
name: Quick Recon
description: Crawl the target, check security headers, summarise findings.
tool: hunt
max_tool_calls: 15
---

Run a quick recon against {{target}}.

1. Crawl with katana (depth 3, js_crawl true) to discover endpoints.
2. Send a GET request to the root path and inspect the response headers for security
   misconfigurations (missing CSP, HSTS, X-Frame-Options, etc.).
3. List all discovered endpoints.
4. Use `write_note` (filename: `recon_summary.md`) to save a concise summary covering:
   target, endpoints found, header issues, and any interesting observations.
   If any credentials or secrets are found, record them immediately with `write_credential`.
