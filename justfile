# FERRET - Forensic Analysis & Request Tracker

# Show available recipes (default)
help:
    @just --list

# Build and start all services (detached)
up:
    docker compose up --build -d
    @echo ""
    @echo "FERRET is running:"
    @echo "  UI    → http://localhost:3000"
    @echo "  API   → http://localhost:8000"
    @echo "  Proxy → 127.0.0.1:1337"

# Dev mode: API + lab in Docker, UI runs on host with hot reload.
# Requires Node.js on the host. UI available at http://localhost:3000.
# Press Ctrl+C to stop the UI; run 'just down' to stop the API containers.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Starting API and lab containers..."
    docker compose up --build -d api lab
    echo ""
    echo "FERRET dev mode:"
    echo "  UI  → http://localhost:3000 (hot reload)"
    echo "  API → http://localhost:8000"
    echo ""
    echo "Press Ctrl+C to stop the UI. Run 'just down' to stop API containers."
    echo ""
    cd src/apps/ui && NEXT_PUBLIC_API_URL=http://localhost:8000 npm run dev

# Stop and remove all services
down:
    docker compose down

# Build images without starting (no k3s import)
build:
    docker compose build

# Tail logs from all services
logs:
    docker compose logs -f

# Show running service status
status:
    docker compose ps

# Run tests for a component.
# Usage:
#   just test api   — run API unit tests inside the running api container
#   just test ui    — run Playwright UI tests (auto-starts Next.js dev server + mock API)
test component:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{component}}" in
      api)
        docker compose build api
        docker compose run --rm -w /app api python -m pytest \
          test_api_v2.py \
          test_api_chat_sessions.py \
          test_api_chat_tools.py \
          test_api_gnaw.py \
          test_api_snare.py \
          test_api_projects.py \
          test_api_openrouter_keys.py \
          test_api_workspaces.py \
          test_api_security.py \
          test_api_setup.py \
          -v --tb=short
        ;;
      ui)
        cd tests/ui
        if [ ! -d node_modules ]; then
          npm install
        fi
        npx playwright test
        ;;
      *)
        echo "Unknown component: {{component}}"
        echo "Available: api, ui"
        exit 1
        ;;
    esac

# Delete all projects (DANGER: wipes all project data)
delete-all-projects:
    @echo "Deleting all projects..."
    curl -X DELETE "http://localhost:8000/api/projects/all?confirm=destroy"

# Reset the database: backs up the current DB then wipes it and restarts the API (DANGER).
# Requires typing 'yes' at the prompt. Use 'just restore' to recover a backup.
# Data is bind-mounted to ${FERRET_DATA_DIR:-./data} on the host (not a named Docker volume).
reset:
    #!/usr/bin/env bash
    set -euo pipefail
    DATA_DIR="${FERRET_DATA_DIR:-./data}"
    echo ""
    echo "The following files will be backed up and replaced with a fresh database:"
    echo ""
    found=0
    for f in "${DATA_DIR}/ferret.db" "${DATA_DIR}/ferret.db-wal" "${DATA_DIR}/ferret.db-shm"; do
        if [[ -f "$f" ]]; then
            size=$(du -sh "$f" 2>/dev/null | cut -f1)
            echo "  $f  ($size)"
            found=1
        fi
    done
    if [[ $found -eq 0 ]]; then
        echo "  (no database files found in ${DATA_DIR})"
    fi
    echo ""
    read -r -p "⚠️  This will wipe ALL Ferret data. Type 'yes' to confirm: " confirm
    [[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }
    echo "Stopping API container..."
    docker compose stop api
    if [[ -f "${DATA_DIR}/ferret.db" ]]; then
        BACKUP="${DATA_DIR}/ferret.db.bak.$(date +%Y%m%d_%H%M%S)"
        mv "${DATA_DIR}/ferret.db" "$BACKUP"
        rm -f "${DATA_DIR}/ferret.db-wal" "${DATA_DIR}/ferret.db-shm"
        echo "DB backed up to $BACKUP"
    else
        echo "No DB file found — nothing to back up."
    fi
    echo "Restarting API (will re-create schema + temp workspace)..."
    docker compose up -d api
    echo ""
    echo "Database reset complete. Fresh temp workspace ready."

# Restore a previous database backup created by 'just reset'.
# Lists available backups and prompts for selection.
restore:
    #!/usr/bin/env bash
    set -euo pipefail
    DATA_DIR="${FERRET_DATA_DIR:-./data}"
    mapfile -t BACKUPS < <(ls -t "${DATA_DIR}"/ferret.db.bak.* 2>/dev/null)
    if [[ ${#BACKUPS[@]} -eq 0 ]]; then
        echo "No backups found in ${DATA_DIR}."
        exit 1
    fi
    echo "Available backups:"
    for i in "${!BACKUPS[@]}"; do
        echo "  $((i+1))) ${BACKUPS[$i]}"
    done
    read -r -p "Enter number to restore (or Ctrl+C to cancel): " choice
    idx=$((choice - 1))
    if [[ $idx -lt 0 || $idx -ge ${#BACKUPS[@]} ]]; then
        echo "Invalid selection."; exit 1
    fi
    SELECTED="${BACKUPS[$idx]}"
    echo "Stopping API container..."
    docker compose stop api
    [[ -f "${DATA_DIR}/ferret.db" ]] && mv "${DATA_DIR}/ferret.db" "${DATA_DIR}/ferret.db.pre-restore"
    cp "$SELECTED" "${DATA_DIR}/ferret.db"
    echo "Restored $SELECTED → ${DATA_DIR}/ferret.db"
    echo "Restarting API..."
    docker compose up -d api
    echo "Restore complete."

# Drop into the ferret-lab sandbox container shell
shell:
    docker exec -it ferret-lab bash

# Build the lab image locally (for contributors modifying src/apps/lab/).
# Set FERRET_LAB_IMAGE=ferret-lab:local in .env to use this image instead of GHCR.
build-lab:
    docker buildx build -t ferret-lab:local src/apps/lab

# Rebuild the local lab image and restart the container.
# Requires FERRET_LAB_IMAGE=ferret-lab:local in .env.
restart-lab:
    docker compose stop lab
    docker buildx build -t ferret-lab:local src/apps/lab
    docker compose start lab

# Push a new ferret-lab image to GHCR (maintainers only).
# Requires docker login to ghcr.io and write access to the repo packages.
# CI runs this automatically on push to main when src/apps/lab/** changes.
publish-lab:
    docker buildx build \
        --platform linux/amd64 \
        -t ghcr.io/synlace/ferret-lab:latest \
        --push \
        src/apps/lab

# Create and push a semver release tag, triggering the GA workflow to publish
# a versioned ferret-lab image to GHCR.
# Usage: just tag major | just tag minor | just tag patch
# With no existing tags, major → v1.0.0, minor → v0.1.0, patch → v0.0.1.
tag bump:
    #!/usr/bin/env bash
    set -euo pipefail
    LATEST=$(git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
    if [[ -z "$LATEST" ]]; then
        MAJOR=0; MINOR=0; PATCH=0
    else
        IFS='.' read -r MAJOR MINOR PATCH <<< "${LATEST#v}"
    fi
    case "{{bump}}" in
      major) MAJOR=$((MAJOR+1)); MINOR=0; PATCH=0 ;;
      minor) MINOR=$((MINOR+1)); PATCH=0 ;;
      patch) PATCH=$((PATCH+1)) ;;
      *) echo "Usage: just tag major|minor|patch"; exit 1 ;;
    esac
    NEW="v${MAJOR}.${MINOR}.${PATCH}"
    echo "Tagging ${NEW}..."
    git tag -a "$NEW" -m "Release ${NEW}"
    git push origin "$NEW"
    echo ""
    echo "Tag ${NEW} pushed. GitHub Actions will publish:"
    echo "  ghcr.io/synlace/ferret-lab:${NEW}"
    echo "  ghcr.io/synlace/ferret-lab:latest"

# Integration test: verify the docker-socket-proxy allows only permitted operations.
# Requires a running stack (just up).
# Tests run inside the api container so no host port exposure is needed.
test-docker-proxy:
    #!/usr/bin/env bash
    set -uo pipefail
    PROXY="tcp://docker-proxy:2375"
    PASS=0
    FAIL=0

    run() {
        local label="$1"
        local expect_success="$2"
        shift 2
        local output
        if output=$(docker compose exec -T api docker -H "$PROXY" "$@" 2>&1); then
            if [[ "$expect_success" == "yes" ]]; then
                echo "  PASS  $label"
                PASS=$((PASS + 1))
            else
                echo "  FAIL  $label (expected block, got success)"
                echo "        output: $output"
                FAIL=$((FAIL + 1))
            fi
        else
            if [[ "$expect_success" == "no" ]]; then
                echo "  PASS  $label (correctly blocked)"
                PASS=$((PASS + 1))
            else
                echo "  FAIL  $label (expected success, got error)"
                echo "        output: $output"
                FAIL=$((FAIL + 1))
            fi
        fi
    }

    # Resolve the actual container name/ID for ferret-lab (may differ from service name)
    LAB_CONTAINER=$(docker compose ps -q lab 2>/dev/null | head -1)
    if [[ -z "$LAB_CONTAINER" ]]; then
        echo "ERROR: ferret-lab container not found — is the stack running? (just up)"
        exit 1
    fi

    echo ""
    echo "=== Docker socket proxy integration tests ==="
    echo "    lab container: $LAB_CONTAINER"
    echo ""
    echo "--- Allowed operations ---"
    run "container list (CONTAINERS=1)"  yes  ps -q
    run "exec into ferret-lab (EXEC=1)"  yes  exec "$LAB_CONTAINER" echo proxy-exec-ok

    echo ""
    echo "--- Blocked operations ---"
    run "image pull (IMAGES not permitted)"          no  pull alpine:latest
    run "volume create (VOLUMES not permitted)"      no  volume create ferret-evil-vol
    run "network create (NETWORKS not permitted)"    no  network create ferret-evil-net

    echo ""
    echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
    [[ $FAIL -eq 0 ]] || exit 1
