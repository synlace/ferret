# FERRET - Forensic Analysis & Request Tracker

# Show available recipes (default)
help:
    @just --list

# Pull pre-built images from GHCR, fall back to building from source
up:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Pulling FERRET images from GHCR..."
    if docker compose -f docker-compose.prod.yml pull; then
        docker compose -f docker-compose.prod.yml up -d
    else
        echo "GHCR pull failed — building images from source..."
        just build
        docker compose -f docker-compose.prod.yml up -d
        echo "⚠️  Using locally-built images (not GHCR)."
    fi
    echo ""
    echo "FERRET is running:"
    echo "  UI    → http://localhost:${UI_PORT:-3000}"
    echo "  API   → http://localhost:8000"
    echo "  Proxy → 127.0.0.1:1337"

# Dev mode: build from source, API hot-reloads via watchfiles, UI via npm run dev
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Syncing runner runner.py to api/runner.py..."
    cp src/apps/runner/runner.py src/apps/api/runner.py
    echo "Starting API and runner containers (with hot reload)..."
    docker compose up --build -d api runner
    echo ""
    echo "FERRET dev mode:"
    echo "  UI  → http://localhost:3000 (hot reload)"
    echo "  API → http://localhost:8000 (hot reload via watchfiles)"
    echo ""
    echo "Press Ctrl+C to stop the UI. Run 'just down' to stop API containers."
    echo ""
    EXACT_TAG=$(git describe --exact-match --tags HEAD 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
    APP_VERSION="${EXACT_TAG:-dev}"
    cd src/apps/ui && NEXT_PUBLIC_API_URL=http://localhost:8000 NEXT_PUBLIC_APP_VERSION="$APP_VERSION" npm run dev

# Down all services
down:
    #!/usr/bin/env bash
    docker compose -f docker-compose.prod.yml down 2>/dev/null || true
    docker compose down 2>/dev/null || true

# Build all Docker images from source
build:
    cp src/apps/runner/runner.py src/apps/api/runner.py
    docker compose build

# Tail or search consolidated system logs
logs action="" query="":
    #!/usr/bin/env bash
    set -euo pipefail
    MASTER_LOG="data/ferret_master.jsonl"
    
    if [[ -z "{{action}}" ]]; then
      if ! command -v fzf &> /dev/null; then
        echo "fzf not found. Falling back to default docker-compose logs."
        docker compose logs -f
        exit 0
      fi
      
      if [ ! -f "$MASTER_LOG" ]; then
        echo "Master log file not found yet at $MASTER_LOG"
        echo "Falling back to default docker compose logs."
        docker compose logs -f
        exit 0
      fi
      
      # Select logs using fzf and parse dynamically with jq
      cat "$MASTER_LOG" | jq -r '. | "[\(.timestamp)] [\(.level)] [\(.component)] \(.message)"' | fzf \
        --header "=== FERRET CONSOLIDATED SYSTEM LOGS ===" \
        --prompt "Fuzzy filter logs > " \
        --layout=reverse-list
      exit 0
    fi
    
    case "{{action}}" in
      compose)
        docker compose logs -f
        ;;
      api|runner|docker-shim|ui)
        docker compose logs -f "{{action}}"
        ;;
      grep)
        if [[ -z "{{query}}" ]]; then
          echo "Error: Pattern required. Usage: just logs grep <pattern>"
          exit 1
        fi
        if [ ! -f "$MASTER_LOG" ]; then
          echo "No master log file found yet at $MASTER_LOG"
          exit 1
        fi
        jq -r --arg q "{{query}}" 'select(.message | test($q; "i")) | "[\(.timestamp)] [\(.level)] [\(.component)] \(.message)"' "$MASTER_LOG" || true
        ;;
      clear)
        if [[ -z "{{query}}" ]]; then
          echo "Clearing consolidated master log file ($MASTER_LOG)..."
          echo -n "" > "$MASTER_LOG"
          echo "Master log file truncated."
        else
          case "{{query}}" in
            api|runner|docker-shim|ui)
              CONTAINER_ID=$(docker compose ps -q "{{query}}" 2>/dev/null || true)
              if [[ -z "$CONTAINER_ID" ]]; then
                echo "Error: Service '{{query}}' is not running or doesn't exist."
                exit 1
              fi
              LOG_PATH=$(docker inspect "$CONTAINER_ID" | jq -r '.[0].LogPath' 2>/dev/null || true)
              if [[ -z "$LOG_PATH" ]]; then
                echo "Service '{{query}}' does not use local JSON logs (using journald or other driver)."
                echo "Recreating container to clear logs..."
                docker compose up -d --force-recreate "{{query}}"
                echo "Container '{{query}}' recreated and logs cleared."
              else
                echo "Truncating logs for '{{query}}'..."
                if [ -w "$LOG_PATH" ]; then
                  truncate -s 0 "$LOG_PATH"
                  echo "Logs for '{{query}}' cleared."
                else
                  echo "Log file is write-protected on the host. Running with sudo..."
                  sudo truncate -s 0 "$LOG_PATH"
                  echo "Logs for '{{query}}' cleared."
                fi
              fi
              ;;
            *)
              echo "Unknown service to clear: {{query}}"
              echo "Available: api, runner, docker-shim, ui"
              exit 1
              ;;
          esac
        fi
        ;;
      help|--help|-h)
        echo "Usage: just logs [action] [query]"
        echo ""
        echo "Available:"
        echo "  just logs                        — Interactive master log fuzzy search"
        echo "  just logs compose                — Tail all docker compose service logs"
        echo "  just logs <service>              — Tail specific container (api, runner, ui, docker-shim)"
        echo "  just logs grep <pattern>         — Filter master log by regex pattern"
        echo "  just logs clear                  — Clear the consolidated master logs file"
        echo "  just logs clear <service>        — Clear logs of a specific service (api, runner, ui, docker-shim)"
        exit 0
        ;;
      *)
        echo "Unknown action: {{action}}"
        echo "Available:"
        echo "  just logs                        — Interactive master log fuzzy search"
        echo "  just logs compose                — Tail all docker compose service logs"
        echo "  just logs <service>              — Tail specific container (api, runner, ui, docker-shim)"
        echo "  just logs grep <pattern>         — Filter master log by regex pattern"
        echo "  just logs clear                  — Clear the consolidated master logs file"
        echo "  just logs clear <service>        — Clear logs of a specific service (api, runner, ui, docker-shim)"
        exit 1
        ;;
    esac

# Show running service status
status:
    docker compose ps

# Run tests (api, ui, shim, all)
test component="" verbosity="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{component}}" in
      "")
        echo "Usage: just test <component> [verbosity]"
        echo ""
        echo "Available components:"
        echo "  all   — run all test suites (api, ui, shim) in sequence"
        echo "  api   — run API unit tests inside the running api container"
        echo "  ui    — run Playwright UI tests (auto-starts Next.js dev server + mock API)"
        echo "  shim  — run docker-shim allow/block unit tests (stdlib, no Docker needed)"
        echo ""
        echo "Verbosity (api only):"
        echo "  (default)  — compressed output via rtk + sed filter (current behavior)"
        echo "  full       — raw pytest -v --tb=short output, no compression"
        echo "  debug      — -vv --tb=long --log-cli-level=DEBUG, no compression"
        echo ""
        echo "Examples:"
        echo "  just test api"
        echo "  just test api full"
        echo "  just test api debug"
        exit 0
        ;;
      all)
        just test api "{{verbosity}}"
        just test ui
        just test shim
        ;;
      api)
        docker compose build api >/dev/null 2>&1
        ERR_FILE=$(mktemp)

        case "{{verbosity}}" in
          debug)
            PYTEST_FLAGS="-vv --tb=long --log-cli-level=DEBUG"
            NO_RTK=1
            ;;
          full)
            PYTEST_FLAGS="-v --tb=short"
            NO_RTK=1
            ;;
          *)
            PYTEST_FLAGS="-v --tb=short"
            NO_RTK=0
            ;;
        esac

        TEST_FILES="test_api_v2.py \
          test_api_chat_litellm.py \
          test_api_chat_tools.py \
          test_api_gnaw.py \
          test_api_snare.py \
          test_api_projects.py \
          test_api_openrouter_keys.py \
          test_api_hunts.py \
          test_api_sources.py \
          test_api_auth.py \
          test_api_mfa.py \
          test_api_security.py \
          test_api_security2.py \
          test_api_setup.py \
          test_api_plans.py \
          test_api_runners.py"

        if [[ "$NO_RTK" -eq 1 ]]; then
          if ! docker compose run --rm -w /app api pytest \
            $TEST_FILES \
            $PYTEST_FLAGS 2>"$ERR_FILE"; then
            cat "$ERR_FILE" >&2
            rm -f "$ERR_FILE"
            exit 1
          fi
        else
          if ! docker compose run --rm -w /app api rtk pytest \
            $TEST_FILES \
            $PYTEST_FLAGS 2>"$ERR_FILE" | sed -E '/^\[Entrypoint\]|^\[#\]/d'; then
            cat "$ERR_FILE" >&2
            rm -f "$ERR_FILE"
            exit 1
          fi
        fi
        rm -f "$ERR_FILE"
        ;;
      ui)
        cd tests/ui
        # Kill any stale Next.js dev server on the test port (3099) that may
        # be stuck in a CPU loop, preventing Playwright from starting fresh.
        # This is safe: port 3099 is test-only, never the real dev server (3000).
        kill $(ss -tlnp | grep ':3099' | grep -oP 'pid=\K\d+') 2>/dev/null || true
        if [ ! -d node_modules ]; then
          npm install
        fi
        npx playwright test
        ;;
      shim)
        cd src/apps/docker-shim
        python -m unittest test_shim -v
        ;;
      *)
        echo "Unknown component: {{component}}"
        echo "Available: api, ui, shim"
        exit 1
        ;;
    esac

# Manage runner Dens
den action="" arg1="" arg2="" arg3="" arg4="" arg5="":
    #!/usr/bin/env bash
    set -euo pipefail
    API_URL="http://localhost:8000"
    JSON_FLAG=""
    if [[ "{{arg1}}" == "json" || "{{arg2}}" == "json" || "{{arg3}}" == "json" || "{{arg4}}" == "json" || "{{arg5}}" == "json" ]]; then
      JSON_FLAG="--json"
    fi

    case "{{action}}" in
      "" | "help")
        echo "Usage: just den <action> [arguments]"
        echo ""
        echo "Available actions:"
        echo "  list [json]                                              — List all configured Dens"
        echo "  info <den-id> [json]                                     — Show detailed config of a Den"
        echo "  delete <den-id>                                         — Delete a Den configuration"
        echo "  create <den-id> <name> <local> <max-runners> [json]     — Create or update a Den"
        echo "  destroy-runners [den-id]                                 — Stop/remove all active runners for a Den (or all if omitted)"
        echo "  runners                                                 — List all active registered runners"
        echo ""
        echo "Examples:"
        echo "  just den list"
        echo "  just den info local"
        echo "  just den runners"
        echo "  just den destroy-runners"
        echo "  just den create local \"Local Den\" local 10"
        ;;
      list)
        echo "Configured runner Dens:"
        echo ""
        curl -s "${API_URL}/api/settings/dens" | python3 src/apps/api/format_den.py --mode list $JSON_FLAG
        ;;
      info)
        den_id="{{arg1}}"
        if [[ -z "$den_id" ]]; then
          echo "Error: <den-id> is required for 'info' action"
          exit 1
        fi
        curl -s "${API_URL}/api/settings/dens/${den_id}" | python3 src/apps/api/format_den.py --mode info $JSON_FLAG
        ;;
      delete)
        den_id="{{arg1}}"
        if [[ -z "$den_id" ]]; then
          echo "Error: <den-id> is required for 'delete' action"
          exit 1
        fi
        echo "Deleting Den '${den_id}'..."
        curl -s -X DELETE "${API_URL}/api/settings/dens/${den_id}" | python3 -m json.tool || echo "Failed to delete Den."
        ;;
      create)
        den_id="{{arg1}}"
        name="{{arg2}}"
        type="{{arg3}}"
        max_runners="{{arg4}}"
        aws_region="{{arg5}}"
        if [[ -z "$den_id" || -z "$name" || -z "$type" || -z "$max_runners" ]]; then
          echo "Error: create action requires: <den-id> <name> <local> <max-runners>"
          exit 1
        fi
        payload="{\"id\":\"${den_id}\",\"name\":\"${name}\",\"type\":\"${type}\",\"max_runners\":${max_runners},\"aws_region\":\"${aws_region}\"}"
        echo "Creating/Updating Den '${den_id}'..."
        curl -s -X POST -H "Content-Type: application/json" -d "$payload" "${API_URL}/api/settings/dens" | python3 src/apps/api/format_den.py --mode info $JSON_FLAG
        ;;
      destroy-runners | clean)
        den_id="{{arg1}}"
        if command -v docker &>/dev/null; then
          echo "Stopping and removing local Docker runner containers..."
          docker ps -aq --filter "name=ferret-runner-" | xargs -r docker rm -f 2>/dev/null || true
        fi
        echo "Runner cleanup complete."
        ;;
      runners)
        echo "Active registered runners:"
        echo ""
        curl -s "${API_URL}/api/runners" | python3 src/apps/api/format_runners.py
        ;;
      *)
        echo "Unknown den action: {{action}}"
        echo "Run 'just den' or 'just den help' for usage instructions."
        exit 1
        ;;
    esac

destroy-runners:
    just den destroy-runners all

delete-all-projects:
    @echo "Deleting all projects..."
    curl -X DELETE "http://localhost:8000/api/projects/all?confirm=destroy"

reset:
    #!/usr/bin/env bash
    set -euo pipefail
    DATA_DIR="${FERRET_DATA_DIR:-./data}"
    echo ""
    echo "The following files will be backed up and replaced with fresh instances:"
    echo ""
    found=0
    for f in "${DATA_DIR}/ferret.db" "${DATA_DIR}/ferret.db-wal" "${DATA_DIR}/ferret.db-shm" "${DATA_DIR}/ferret_master.jsonl"; do
        if [[ -f "$f" ]]; then
            size=$(du -sh "$f" 2>/dev/null | cut -f1)
            echo "  $f  ($size)"
            found=1
        fi
    done
    if [[ $found -eq 0 ]]; then
        echo "  (no database or log files found in ${DATA_DIR})"
    fi
    echo ""
    read -r -p "⚠️  This will wipe ALL Ferret data and logs. Type 'yes' to confirm: " confirm
    [[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 1; }
    echo ""
    echo "Stopping API container..."
    docker compose stop api
    if command -v docker &>/dev/null; then
        echo "Stopping and removing any active local ferret-runner containers..."
        docker ps -aq --filter "name=ferret-runner-" | xargs -r docker rm -f 2>/dev/null || true
    fi
    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    if [[ -f "${DATA_DIR}/ferret.db" ]]; then
        BACKUP="${DATA_DIR}/ferret.db.bak.${TIMESTAMP}"
        mv "${DATA_DIR}/ferret.db" "$BACKUP"
        rm -f "${DATA_DIR}/ferret.db-wal" "${DATA_DIR}/ferret.db-shm"
        echo "DB backed up to $BACKUP"
    else
        echo "No DB file found — nothing to back up."
    fi
    if [[ -f "${DATA_DIR}/ferret_master.jsonl" ]]; then
        BACKUP_LOG="${DATA_DIR}/ferret_master.jsonl.bak.${TIMESTAMP}"
        mv "${DATA_DIR}/ferret_master.jsonl" "$BACKUP_LOG"
        echo "Master log backed up to $BACKUP_LOG"
    else
        echo "No master log file found — nothing to back up."
    fi
    echo "Restarting API (will re-create schema, log file + temp workspace)..."
    docker compose up -d api
    echo ""
    echo "Database and master log reset complete. Fresh temp workspace ready."

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

# Drop into a container shell (runner or api)
shell service="runner":
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "{{service}}" == "api" ]]; then
      if docker compose ps -q api 2>/dev/null | grep -q .; then
        docker compose exec -it api bash
      elif docker compose -f docker-compose.prod.yml ps -q api 2>/dev/null | grep -q .; then
        docker compose -f docker-compose.prod.yml exec -it api bash
      else
        CONTAINER_ID=$(docker ps -q --filter "name=ferret-api" | head -n 1)
        if [[ -n "$CONTAINER_ID" ]]; then
          docker exec -it "$CONTAINER_ID" bash
        else
          echo "Error: ferret-api container is not running."
          exit 1
        fi
      fi
    elif [[ "{{service}}" == "runner" ]]; then
      docker exec -it ferret-runner bash
    else
      echo "Unknown service: {{service}}"
      echo "Available: runner, api"
      exit 1
    fi

build-runner:
    docker buildx build -t ferret-runner:local src/apps/runner

restart-runner:
    docker compose stop runner
    docker buildx build -t ferret-runner:local src/apps/runner
    docker compose start runner

runner key api_url="http://localhost:8000":
    #!/usr/bin/env bash
    set -euo pipefail
    IMAGE="${FERRET_RUNNER_IMAGE_LOCAL:-ghcr.io/synlace/ferret-runner:latest}"
    KEY_SHORT=$(echo -n "{{key}}" | md5sum | cut -c1-6)
    NAME="ferret-runner-${KEY_SHORT}"
    echo "Starting isolated outbound runner container: ${NAME}"
    echo "Connecting to platform: {{api_url}}"
    docker run -d \
        --name "${NAME}" \
        --restart unless-stopped \
        --cap-add NET_ADMIN \
        --cap-add NET_RAW \
        --cap-add SYS_PTRACE \
        -e FERRET_API_URL="{{api_url}}" \
        -e FERRET_RUNNER_KEY="{{key}}" \
        -e FERRET_RUNNER_ID="${NAME}" \
        "${IMAGE}"
    echo "Runner started successfully. To view its logs, run:"
    echo "  docker logs -f ${NAME}"

publish-runner:
    docker buildx build \
        --platform linux/amd64 \
        -t ghcr.io/synlace/ferret-runner:latest \
        --push \
        src/apps/runner

# Tag: bump major/minor/patch version
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
    echo "Pinning docker-compose.prod.yml defaults to ${NEW}..."
    # Update the fallback version in docker-compose.prod.yml so `just up`
    # (without FERRET_VERSION set) pulls this release rather than :latest.
    sed -i \
        -e "s|ferret-docker-shim:\${FERRET_VERSION:-v[^}]*}|ferret-docker-shim:\${FERRET_VERSION:-${NEW}}|g" \
        -e "s|ferret-api:\${FERRET_VERSION:-v[^}]*}|ferret-api:\${FERRET_VERSION:-${NEW}}|g" \
        -e "s|ferret-ui:\${FERRET_VERSION:-v[^}]*}|ferret-ui:\${FERRET_VERSION:-${NEW}}|g" \
        -e "s|ferret-runner:v[0-9][^}]*}|ferret-runner:${NEW}}|g" \
        docker-compose.prod.yml
    git add docker-compose.prod.yml
    git commit -m "chore(release): pin docker-compose.prod.yml defaults to ${NEW}"
    echo "Tagging ${NEW}..."
    git tag -a "$NEW" -m "Release ${NEW}"
    git push origin HEAD "$NEW"
    echo ""
    echo "Tag ${NEW} pushed. GitHub Actions will publish:"
    echo "  ghcr.io/synlace/ferret-runner:${NEW}"
    echo "  ghcr.io/synlace/ferret-runner:latest"
    echo ""
    echo "Rebuilding UI image with NEXT_PUBLIC_APP_VERSION=${NEW}..."
    NEXT_PUBLIC_APP_VERSION="${NEW}" docker compose build ui
    # Stage, commit, push, PR, and merge changes in one go (handles repos with PR-only rulesets)
pr-land message branch_name="":
    #!/usr/bin/env bash
    set -euo pipefail
    command -v gh >/dev/null 2>&1 || { echo "Error: gh CLI is required."; exit 1; }
    BRANCH="{{branch_name}}"
    if [[ -z "$BRANCH" ]]; then
      SLUG=$(echo "{{message}}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g' | sed -E 's/^-|-$//g' | cut -c1-30)
      BRANCH="auto-$SLUG"
    fi
    CURRENT_BRANCH=$(git branch --show-current)
    if [[ "$CURRENT_BRANCH" == "main" ]]; then
      echo "Creating and switching to branch: $BRANCH"
      git checkout -b "$BRANCH"
    else
      echo "Using current branch: $CURRENT_BRANCH"
      BRANCH="$CURRENT_BRANCH"
    fi
    echo "Staging and committing..."
    git add .
    git commit -m "{{message}}" || echo "No changes to commit."
    echo "Pushing branch $BRANCH..."
    git push -u origin "$BRANCH"
    echo "Creating Pull Request..."
    PR_URL=$(gh pr create --title "{{message}}" --body "Automated land via 'just pr-land'.")
    echo "PR Created: $PR_URL"
    echo "Merging Pull Request..."
    gh pr merge --merge --delete-branch
    echo "Syncing main..."
    git checkout main
    git pull origin main
    echo "Successfully landed changes!"

