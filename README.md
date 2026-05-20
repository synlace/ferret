# Ferret

<p align="center">
  <img src="assets/ferret.png" alt="Ferret" width="96" />
</p>

<p align="center">
  <strong>The collaborative MITM proxy for security testers.</strong>
</p>

<p align="center">
  Capture HTTP traffic, annotate requests with AI, run hunt sessions, replay traffic, and track findings from one interface.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#screenshots">Screenshots</a>
  ·
  <a href="#configuration">Configuration</a>
  ·
  <a href="#security">Security</a>
  ·
  <a href="#contributing">Contributing</a>
</p>

---

## Overview

Ferret is an AI-assisted HTTP interception proxy built for security testers.

Point your browser, CLI tool, or testing workflow at:

```text
127.0.0.1:1337
````

Ferret captures requests and responses, stores them locally, annotates traffic with AI, and gives you tools to replay, modify, test, and turn interesting behaviour into findings.

It is designed for workflows where you want more than a passive proxy: you want something that helps you think, test, and document as you go.

---

## Features

* **Intercepting proxy** — capture HTTP and HTTPS traffic through mitmproxy.
* **Request history** — browse, filter, inspect, and replay captured traffic.
* **AI annotations** — enrich requests with security-relevant context.
* **Hunts** — run AI-assisted hunt sessions across captured traffic.
* **Findings** — track vulnerabilities with severity, host, type, evidence, and status.
* **Snare** — intercept and modify requests or responses in-flight.
* **Gnaw** — repeater-style tabs for editing and resending HTTP requests.
* **Workspaces** — per-session `scripts/`, `tests/`, and `notes/` directories.
* **Projects** — separate request history, findings, workspaces, and API keys.
* **Authentication** — password login, session cookies, optional API key access, and TOTP 2FA.
* **Local-first storage** — SQLite-backed data stored in a local bind-mounted directory.

---

## Screenshots

<table>
<tr>
<td width="50%">

![Hunts](assets/20260518_hunts.png)

**Hunts**

AI-assisted hunt sessions that search request history, write and run tests, and create findings.

</td>
<td width="50%">

![History](assets/20260518_history.png)

**History**

A full proxied request log with AI annotations, timings, status codes, and inline request/response editors.

</td>
</tr>
<tr>
<td width="50%">

![Findings](assets/20260518_findings.png)

**Findings**

A vulnerability tracker with severity, host, type, AI-generated descriptions, and evidence snippets.

</td>
<td width="50%">

![Settings](assets/20260518_settings.png)

**Settings**

Manage the CA certificate, password, 2FA, AI provider, API keys, and proxy status.

</td>
</tr>
<tr>
<td colspan="2" align="center">

![Setup](assets/20260518_setup.png)

**Setup wizard**

First-run setup for password creation and AI provider configuration.

</td>
</tr>
</table>

---

## Quick start

### Requirements

* Docker
* Docker Compose
* [`just`](https://github.com/casey/just)

### Install

```bash
git clone https://github.com/synlace/ferret.git
cd ferret

cp .env.example .env   # optional
just up
```

Or use Docker Compose directly:

```bash
docker compose up --build -d
```

### Open Ferret

| Service | URL                     |
| ------- | ----------------------- |
| UI      | `http://localhost:3000` |
| API     | `http://localhost:8000` |
| Proxy   | `127.0.0.1:1337`        |

Open:

```text
http://localhost:3000
```

The first-run setup wizard will ask you to set a password and choose an AI provider.

---

## Using the proxy

Configure your browser, CLI tool, or test client to use:

```text
HTTP proxy:  127.0.0.1:1337
HTTPS proxy: 127.0.0.1:1337
```

For HTTPS interception, download and install the mitmproxy CA certificate from the **Settings** page.

---

## Authentication

Ferret requires authentication on every install.

### Browser login

1. Open the UI for the first time.
2. Set a password in the setup wizard.
3. Complete AI provider setup.
4. Log in at `/login`.
5. Ferret issues a 24-hour `HttpOnly` `SameSite=Strict` session cookie.

### Two-factor authentication

TOTP-based 2FA can be enabled from the **Settings** page.

Once enabled, a valid authenticator code is required at login.

### API access

Set a static API key in `.env`:

```env
FERRET_API_KEY=your-random-secret
```

Then use it as a Bearer token:

```bash
curl -H "Authorization: Bearer your-random-secret" \
  http://localhost:8000/api/requests
```

Session cookies and Bearer tokens are checked independently.

---

## Configuration

Copy `.env.example` to `.env` to preconfigure Ferret.

Most AI provider settings can also be configured from the setup wizard.

| Variable                 |                         Default | Description                                     |
| ------------------------ | ------------------------------: | ----------------------------------------------- |
| `FERRET_API_KEY`         |                               — | Static Bearer token for programmatic API access |
| `OPENROUTER_MODEL`       | `google/gemini-3-flash-preview` | Default OpenRouter model                        |
| `PROXY_HOST`             |                       `0.0.0.0` | Proxy bind address                              |
| `PROXY_PORT`             |                          `1337` | Proxy port                                      |
| `UI_PORT`                |                          `3000` | UI port                                         |
| `FERRET_DATA_DIR`        |                        `./data` | Persistent data directory                       |
| `NEXT_PUBLIC_API_URL`    |         `http://localhost:8000` | API URL used by the browser                     |
| `NEXT_PUBLIC_SIGINT_URL` |                               — | Optional SIGINT/news feed JSON URL              |

---

## Supported AI providers

Ferret can be configured with:

* OpenRouter
* OpenAI
* Anthropic
* Gemini
* DeepSeek
* Mistral
* Ollama
* LM Studio

Provider setup can be completed from the first-run wizard.

---

## `just` commands

| Command         | Description                                     |
| --------------- | ----------------------------------------------- |
| `just up`       | Build and start all services                    |
| `just down`     | Stop all services                               |
| `just dev`      | Run API/lab in Docker and UI hot reload on host |
| `just logs`     | Tail service logs                               |
| `just test api` | Run API unit tests                              |
| `just test ui`  | Run Playwright UI tests                         |
| `just reset`    | Wipe the local database                         |
| `just shell`    | Open a shell in the lab container               |

---

## Architecture

```text
Browser / tool
      │
      ▼
127.0.0.1:1337
      │
      ▼
ferret-api :8000 / :1337
FastAPI + mitmproxy + SQLite
      │
      ├── docker exec
      ▼
ferret-lab
pytest, ffuf, sqlmap, scripts, tests, notes
      │
      ▼
ferret-ui :3000
Next.js
```

All persistent data is stored under:

```text
${FERRET_DATA_DIR:-./data}
```

Ferret uses bind mounts rather than named Docker volumes.

---

## Resetting Ferret

To wipe local state and restart the setup wizard:

```bash
just reset
```

This removes the local database, including credentials.

You can also reset setup through the API when authenticated:

```bash
curl -X DELETE \
  -H "Authorization: Bearer your-random-secret" \
  http://localhost:8000/api/setup
```

---

## Development

For local UI development with hot reload:

```bash
just dev
```

This runs the API and lab environment in Docker while running the UI on the host.

Run tests with:

```bash
just test api
just test ui
```

---

## Security

Ferret is intended for local security testing workflows.

Before exposing Ferret outside localhost, make sure you understand the risks:

* The proxy can capture sensitive HTTP traffic.
* The API exposes request history and findings.
* The lab container can execute testing tools.
* API keys and AI provider credentials should be treated as secrets.

Use strong passwords and enable 2FA where appropriate.

### Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

See [`.github/SECURITY.md`](.github/SECURITY.md) for the full disclosure policy and how to report.

### Disclosed reports

Past disclosures are published in [`security/`](security/README.md) after fixes are available.

---

## Contributing

Ferret is actively being developed.

Ideas, bug reports, feature requests, and contributions are welcome.

Want to help build it?

Email: [aidan@synlace.ai](mailto:aidan@synlace.ai)

---

## License

MIT — see [LICENSE](LICENSE).

```
