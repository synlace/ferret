---
name: Full Recon
description: Deep crawl + ffuf directory fuzzing + JS endpoint extraction.
tool: hunt
max_tool_calls: 30
---

Run a full recon against {{target}}.

1. Crawl with katana (depth 5, js_crawl true, headless false).
2. Run ffuf on the root path with the raft-medium-directories wordlist to find hidden directories.
3. Use `run_script` (python3, name: `extract_js_endpoints`) to extract any API endpoints
   from discovered JavaScript files.
4. Check security headers on the root path.
5. Use `write_note` (filename: `recon_full.md`) to save a detailed report covering all findings:
   endpoints discovered, hidden directories, JS-extracted API paths, and header issues.
   If any credentials or secrets are found at any step, record them immediately with `write_credential`.
