---
name: Subdomain Enum
description: Discover subdomains via subfinder + DNS fuzzing, probe live hosts, scan for vulns.
tool: hunt
max_tool_calls: 35
---

Enumerate subdomains for {{target}}.

1. Extract the base domain from {{target}} (strip scheme and path).

2. Run subfinder against the base domain to collect passive subdomain intelligence.

3. Run ffuf in DNS mode against the base domain using the subdomains-top1million-5000 wordlist
   to discover additional subdomains not found passively.

4. Merge both lists, deduplicate, and for each unique subdomain:
   a. Send a GET request to https://<subdomain> (and http:// if https fails) to check liveness.
   b. Record: status code, redirect target (if any), Server header, X-Powered-By, title tag.
   c. Note any interesting response patterns (login pages, admin panels, API endpoints,
      default server pages, error pages leaking stack traces).

5. For any live subdomain returning 200 or an interesting redirect:
   Run nuclei against it with tags: `exposure,misconfig,default-login,takeover`
   to catch low-hanging vulnerabilities.

6. Use `write_note` (filename: `subdomains.md`) to save a structured report:
   - Total subdomains discovered (passive + active)
   - Live vs dead breakdown
   - Per-subdomain: URL, status, server, title, nuclei findings
   - Notable findings highlighted at the top

7. If any credentials, API keys, or secrets are exposed on any subdomain,
   record them immediately with `write_credential`.
