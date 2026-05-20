# Security Disclosures

This directory contains publicly disclosed security reports for Ferret.

Reports are published here after a fix is available and the coordinated disclosure period has ended.

For the full disclosure policy and how to report a new vulnerability, see [`.github/SECURITY.md`](../.github/SECURITY.md).

---

## Disclosed Reports

| ID | Title | Severity | Disclosed |
|---|---|---|---|
| [DISC-2026-001](DISC-2026-001.md) | Unauthenticated RCE via SSRF + docker-socket-proxy misconfiguration (host compromise) | Critical | 2026-05-20 |

---

## Report Format

Each report follows the template in [`template.md`](template.md).

Reports are named using one of:

| Pattern | Example | When to use |
|---|---|---|
| CVE ID | `CVE-2026-12345.md` | After a CVE has been assigned |
| Sequential | `DISC-2026-001.md` | Before CVE assignment or for internal tracking |
