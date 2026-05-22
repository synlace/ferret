---
name: Subdomain Enum
description: Discover subdomains via DNS fuzzing, probe each live host.
tool: hunt
max_tool_calls: 20
---

Enumerate subdomains for {{target}}.

1. Extract the base domain from {{target}}.
2. Run ffuf with the subdomains-top1million-5000 wordlist against the base domain using DNS mode.
3. For each discovered subdomain, send a GET request to check if it is live.
4. Note the status code, server header, and title of each live subdomain.
5. Use `write_note` (filename: `subdomains.md`) to save all results: discovered subdomains,
   live vs dead status, server headers, and page titles.
   If any credentials or secrets are exposed on any subdomain, record them with `write_credential`.
