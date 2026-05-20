# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Ferret, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

### How to report

Email: [aidan@synlace.ai](mailto:aidan@synlace.ai)

Include as much detail as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The version of Ferret you tested against
- Any suggested mitigations

### What to expect

| Step | Timeline |
|---|---|
| Acknowledgement | Within 3 business days |
| Initial assessment | Within 7 business days |
| Fix or mitigation | Dependent on severity and complexity |
| Public disclosure | Coordinated with reporter after fix is available |

We follow a **coordinated disclosure** model. We ask that you give us reasonable time to investigate and address the issue before publishing details publicly.

---

## Disclosed Vulnerabilities

Disclosed security reports are published in [`security/`](../security/README.md) after fixes are available.

---

## Scope

Ferret is a **local-first** tool intended to run on `localhost`. The following are considered in-scope:

- Authentication bypass or privilege escalation in the API
- Remote code execution via the proxy, lab container, or API
- Sensitive data exposure (credentials, API keys, captured traffic)
- CSRF or session fixation in the web UI
- Injection vulnerabilities (SQL, command, template)

The following are **out of scope**:

- Issues that require physical access to the machine running Ferret
- Vulnerabilities in third-party dependencies (report those upstream)
- Issues only exploitable by the authenticated owner of the Ferret instance
- Self-XSS with no meaningful impact
