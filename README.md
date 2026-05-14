# ferret

**AI-assisted HTTP interception and analysis for security testers.**

## Screenshots

<table>
<tr>
<td width="50%">

![Findings](assets/20260515_004014.png)

**Findings** — Vulnerability list with severity, host, type, and evidence.

</td>
<td width="50%">

![History](assets/20260515_004037.png)

**History** — Proxied request log with AI annotations, timing, and response detail.

</td>
</tr>
<tr>
<td width="50%">

![Gnaw](assets/20260515_004055.png)

**Gnaw** — Persistent repeater. Edit and resend requests with full request/response editors.

</td>
<td width="50%">

![Workspaces](assets/20260515_004131.png)

**Workspaces** — AI chat with script runner. Execute scripts against the target with project-scoped context.

</td>
</tr>
<tr>
<td width="50%">

![Snare](assets/20260515_004201.png)

**Snare** — Intercept requests in-flight. Edit and forward or drop before they reach the server.

</td>
<td width="50%">

![Workspaces — Test Runner](assets/20260515_004939.png)

**Workspaces (Tests)** — Write and run pytest tests in the workspace with inline output.

</td>
</tr>
</table>

---

## Install

**Requirements:** Docker, Docker Compose, [`just`](https://github.com/casey/just)

```bash
git clone https://github.com/synlace/ferret.git
cd ferret
cp .env.example .env          # set OPENROUTER_PROVISIONING_KEY at minimum
just up
# or: docker compose up --build -d
```

| Service | URL |
|---------|-----|
| UI      | http://localhost:3000 |
| API     | http://localhost:8000 |
| Proxy   | `127.0.0.1:1337` |

Point your browser or tool at `127.0.0.1:1337`. For HTTPS, install the mitmproxy CA cert from the proxy settings page.

---

## Configuration

Copy `.env.example` to `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_PROVISIONING_KEY` | — | Master OpenRouter key (required for AI) |
| `OPENROUTER_MODEL` | `google/gemini-3-flash-preview` | Model for chat and annotations |
| `PROXY_HOST` | `0.0.0.0` | Proxy bind address |
| `PROXY_PORT` | `1337` | Proxy port |
| `UI_PORT` | `3000` | UI port |
| `FERRET_DATA_DIR` | `./data` | Host path for all persistent data |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | API URL as seen by the browser |
| `NEXT_PUBLIC_SIGINT_URL` | — | Optional SIGINT news feed JSON URL |

---

## Features

- **Intercepting proxy** — mitmproxy on `:1337`, traffic stored in SQLite
- **Request history** — browse, filter, replay captured requests
- **AI chat** — multi-session chat via OpenRouter; context scoped to a project
- **Findings** — track vulnerabilities with severity, status, and host tagging
- **Workspaces** — per-session `scripts/`, `tests/`, `notes/` directories, editable and runnable in the lab container
- **Snare** — intercept and modify requests/responses in-flight
- **Gnaw** — persistent repeater tabs with proxy routing
- **Projects** — separate request history, findings, workspaces, and API keys per project

---

## `just` recipes

| Recipe | Description |
|--------|-------------|
| `just up` | Build and start all services |
| `just down` | Stop all services |
| `just dev` | API/lab in Docker, UI hot-reload on host (requires Node.js) |
| `just logs` | Tail logs |
| `just test api` | API unit tests |
| `just test ui` | Playwright UI tests |
| `just reset` | Wipe the database |
| `just shell` | Shell into the lab container |

---

## Architecture

```
Browser / tool → 127.0.0.1:1337
                      │
               ferret-api :8000/:1337   (FastAPI + mitmproxy, SQLite)
                      │ docker exec
               ferret-lab               (pytest, ffuf, sqlmap…)
               ferret-ui  :3000         (Next.js)
```

All data is bind-mounted to `${FERRET_DATA_DIR:-./data}` — no named Docker volumes.

---

## License

MIT — see [LICENSE](LICENSE).
