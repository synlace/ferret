# FERRET - Forensic Analysis & Request Tracker

# Show available recipes (default)
help:
    @just --list

# Production: pull pre-built images from GHCR and start all services.
# Users can clone the repo and run `just up` without Node.js, Python, or a build step.
# Pin a specific release with: FERRET_VERSION=v1.2.0 just up
up:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Pulling FERRET images from GHCR..."
    docker compose -f docker-compose.prod.yml pull
    docker compose -f docker-compose.prod.yml up -d
    echo ""
    echo "FERRET is running:"
    echo "  UI    → http://localhost:${UI_PORT:-3000}"
    echo "  API   → http://localhost:8000"
    echo "  Proxy → 127.0.0.1:1337"

# Dev mode: build from source, API hot-reloads via watchfiles, UI via npm run dev.
# Requires Node.js on the host. UI available at http://localhost:3000.
# Press Ctrl+C to stop the UI; run 'just down' to stop the API containers.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Syncing runner runner.py to api/runner.py..."
    cp src/apps/runner/runner.py src/apps/api/runner.py
    RUNNER_IMG="${FERRET_RUNNER_IMAGE_LOCAL:-}"
    if [[ -z "$RUNNER_IMG" || "$RUNNER_IMG" == ghcr.io/* ]]; then
        echo "Pulling latest ferret-runner image from GHCR..."
        docker compose pull runner
    fi
    echo "Starting API and runner containers (with hot reload)..."
    docker compose up --build -d api runner
    echo ""
    echo "FERRET dev mode:"
    echo "  UI  → http://localhost:3000 (hot reload)"
    echo "  API → http://localhost:8000 (hot reload via watchfiles)"
    echo ""
    echo "Press Ctrl+C to stop the UI. Run 'just down' to stop API containers."
    echo ""
    # Only show a version tag when HEAD is exactly on a release tag.
    # Any other state (untagged commit, dirty tree) shows "dev" so the nav
    # always reads "dev" during local development.
    EXACT_TAG=$(git describe --exact-match --tags HEAD 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true)
    APP_VERSION="${EXACT_TAG:-dev}"
    cd src/apps/ui && NEXT_PUBLIC_API_URL=http://localhost:8000 NEXT_PUBLIC_APP_VERSION="$APP_VERSION" npm run dev

# Stop and remove all services (works for both prod and dev)
down:
    #!/usr/bin/env bash
    docker compose -f docker-compose.prod.yml down 2>/dev/null || true
    docker compose down 2>/dev/null || true

# Build images without starting (no k3s import)
build:
    cp src/apps/runner/runner.py src/apps/api/runner.py
    docker compose build

# Tail logs from all services
logs:
    docker compose logs -f

# Show running service status
status:
    docker compose ps

# Run tests for a component.
# Usage:
#   just test       — show this help
#   just test all   — run all test suites (api, ui, shim) in sequence
#   just test api   — run API unit tests inside the running api container
#   just test ui    — run Playwright UI tests (auto-starts Next.js dev server + mock API)
#   just test shim  — run docker-shim allow/block unit tests (stdlib, no Docker needed)
test component="":
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{component}}" in
      "")
        echo "Usage: just test <component>"
        echo ""
        echo "Available components:"
        echo "  all   — run all test suites (api, ui, shim) in sequence"
        echo "  api   — run API unit tests inside the running api container"
        echo "  ui    — run Playwright UI tests (auto-starts Next.js dev server + mock API)"
        echo "  shim  — run docker-shim allow/block unit tests (stdlib, no Docker needed)"
        exit 0
        ;;
      all)
        just test api
        just test ui
        just test shim
        ;;
      api)
        docker compose build api
        docker compose run --rm -w /app api python -m pytest \
          test_api_v2.py \
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
          test_api_runners.py \
          -v --tb=short
        ;;
      ui)
        cd tests/ui
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

# Manage runner Dens (Local or AWS Fargate environments)
# Usage:
#   just den list                    — List all configured Dens
#   just den info <den-id>           — Show detailed config of a Den
#   just den delete <den-id>         — Delete a Den configuration
#   just den create <den-id> <name> <type> <max-runners> [aws-region]  — Create/update a Den
#   just den destroy-runners [den-id] — Stop/remove all active runners for a Den (or all Dens if omitted)
#   (Add 'json' as a final argument to any command to receive raw JSON output)
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
        echo "  create <den-id> <name> <local|fargate> <max-runners> [aws-region] [json] — Create or update a Den"
        echo "  destroy-runners [den-id]                                 — Stop/remove all active runners for a Den (or all if omitted)"
        echo "  shell <runner-id> [command] [--verbose|-v]               — Drop into an interactive shell or run a command inside a Fargate runner"
        echo "  runners                                                 — List all active registered runners"
        echo ""
        echo "Examples:"
        echo "  just den list"
        echo "  just den info local"
        echo "  just den runners"
        echo "  just den destroy-runners"
        echo "  just den destroy-runners production-fargate"
        echo "  just den create production-fargate \"Prod Fargate\" fargate 15 us-east-1"
        echo "  just den shell runner-fargate-aws-ed80f3"
        echo "  just den shell runner-fargate-aws-ed80f3 \"pwd\""
        echo "  just den shell runner-fargate-aws-ed80f3 \"pwd\" --verbose"
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
          echo "Error: create action requires: <den-id> <name> <local|fargate> <max-runners>"
          exit 1
        fi
        payload="{\"id\":\"${den_id}\",\"name\":\"${name}\",\"type\":\"${type}\",\"max_runners\":${max_runners},\"aws_region\":\"${aws_region}\"}"
        echo "Creating/Updating Den '${den_id}'..."
        curl -s -X POST -H "Content-Type: application/json" -d "$payload" "${API_URL}/api/settings/dens" | python3 src/apps/api/format_den.py --mode info $JSON_FLAG
        ;;
      destroy-runners | clean)
        den_id="{{arg1}}"
        if [[ -z "$den_id" || "$den_id" == "all" ]]; then
          echo "Destroying all runners across all Dens..."
          # Clean Fargate tasks
          if command -v aws &>/dev/null; then
            echo "Stopping active AWS Fargate tasks in cluster 'ferret-runners'..."
            TASK_ARNS=$(aws ecs list-tasks --cluster "ferret-runners" --query "taskArns" --output text 2>/dev/null || true)
            if [[ -n "$TASK_ARNS" && "$TASK_ARNS" != "None" ]]; then
              for task in $TASK_ARNS; do
                echo "  -> Stopping Fargate task: $task"
                aws ecs stop-task --cluster "ferret-runners" --task "$task" >/dev/null 2>&1 || true
              done
              echo "Waiting for Fargate tasks to fully stop..."
              aws ecs wait tasks-stopped --cluster "ferret-runners" --tasks $TASK_ARNS 2>/dev/null || true
            else
              echo "No active Fargate tasks found."
            fi
          fi
          # Clean Local docker
          if command -v docker &>/dev/null; then
            echo "Stopping and removing local Docker runner containers..."
            docker ps -aq --filter "name=ferret-runner-" | xargs -r docker rm -f 2>/dev/null || true
          fi
        elif [[ "$den_id" == "local" ]]; then
          echo "Destroying local Docker runners..."
          if command -v docker &>/dev/null; then
            docker ps -aq --filter "name=ferret-runner-" | xargs -r docker rm -f 2>/dev/null || true
          fi
        else
          # Assume specific Fargate or custom Den
          echo "Destroying runners on Fargate Den: ${den_id}..."
          if command -v aws &>/dev/null; then
            # We can filter Fargate tasks by checking FERRET_RUNNER_ID prefixed with runner-fargate-<den_id>
            echo "Querying tasks in cluster 'ferret-runners' to find runners for Den: ${den_id}..."
            TASK_ARNS=$(aws ecs list-tasks --cluster "ferret-runners" --query "taskArns" --output text 2>/dev/null || true)
            if [[ -n "$TASK_ARNS" && "$TASK_ARNS" != "None" ]]; then
              for task in $TASK_ARNS; do
                RUNNER_ID=$(aws ecs describe-tasks --cluster "ferret-runners" --tasks "$task" --query "tasks[0].overrides.containerOverrides[0].environment[?name=='FERRET_RUNNER_ID'].value" --output text 2>/dev/null || true)
                if [[ "$RUNNER_ID" == *"runner-fargate-${den_id}-"* ]]; then
                  echo "  -> Stopping Fargate task: $task ($RUNNER_ID)"
                  aws ecs stop-task --cluster "ferret-runners" --task "$task" >/dev/null 2>&1 || true
                fi
              done
            else
              echo "No active Fargate tasks found."
            fi
          fi
        fi
        echo "Runner cleanup complete."
        ;;
      shell)
        runner_id="{{arg1}}"
        cmd_arg="{{arg2}}"
        if [[ -z "$runner_id" ]]; then
          echo "Error: <runner-id> is required for 'shell' action"
          echo "Usage: just den shell <runner-id> [command]"
          exit 1
        fi

        # Determine how to execute commands inside the API container
        EXEC_CMD=""
        if docker compose -f docker-compose.prod.yml ps -q api &>/dev/null; then
          EXEC_CMD="docker compose -f docker-compose.prod.yml exec -it api"
        elif docker compose ps -q api &>/dev/null; then
          EXEC_CMD="docker compose exec -it api"
        else
          CONTAINER_ID=$(docker ps -q --filter "name=ferret-api" | head -n 1)
          if [[ -n "$CONTAINER_ID" ]]; then
            EXEC_CMD="docker exec -it $CONTAINER_ID"
          else
            echo "Error: ferret-api container is not running."
            exit 1
          fi
        fi

        # Pass variables and command to execute within the API container
        PY_ARGS=("$runner_id")
        if [[ -n "$cmd_arg" ]]; then
          PY_ARGS+=("$cmd_arg")
        fi
        if [[ -n "{{arg3}}" ]]; then
          PY_ARGS+=("{{arg3}}")
        fi
        if [[ -n "{{arg4}}" ]]; then
          PY_ARGS+=("{{arg4}}")
        fi
        if [[ -n "{{arg5}}" ]]; then
          PY_ARGS+=("{{arg5}}")
        fi

        $EXEC_CMD python3 ecs_exec_jump.py "${PY_ARGS[@]}"
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

# Stop and remove all active local and AWS Fargate runner instances
destroy-runners:
    just den destroy-runners all

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
    echo ""

    # Stop any active AWS Fargate task runners to prevent orphaned containers/duplicate spawning
    if command -v aws &>/dev/null; then
        echo "Stopping active AWS Fargate task runners to prevent duplicate spawning..."
        TASK_ARNS=$(aws ecs list-tasks --cluster "ferret-runners" --query "taskArns" --output text 2>/dev/null || true)
        if [[ -n "$TASK_ARNS" && "$TASK_ARNS" != "None" ]]; then
            for task in $TASK_ARNS; do
                aws ecs stop-task --cluster "ferret-runners" --task "$task" >/dev/null 2>&1 || true
            done
        fi
    fi

    read -r -p "Do you also want to destroy all AWS resources first? (y/N): " destroy_aws
    if [[ "$destroy_aws" =~ ^[Yy](es)?$ ]]; then
        echo "Wiping AWS resources before deleting the database..."
        just destroy-aws
    fi
    echo "Stopping API container..."
    docker compose stop api

    # Stop and remove any active local ferret-runner containers to prevent orphaned spam after reset
    if command -v docker &>/dev/null; then
        echo "Stopping and removing any active local ferret-runner containers..."
        docker ps -aq --filter "name=ferret-runner-" | xargs -r docker rm -f 2>/dev/null || true
    fi
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

# Drop into the ferret-runner sandbox container shell
shell:
    docker exec -it ferret-runner bash

# Build the runner image locally (for contributors modifying src/apps/runner/).
# Set FERRET_RUNNER_IMAGE_LOCAL=ferret-runner:local in .env to use this image instead of GHCR.
build-runner:
    docker buildx build -t ferret-runner:local src/apps/runner

# Rebuild the local runner image and restart the container.
# Requires FERRET_RUNNER_IMAGE_LOCAL=ferret-runner:local in .env.
restart-runner:
    docker compose stop runner
    docker buildx build -t ferret-runner:local src/apps/runner
    docker compose start runner

# Start an isolated outbound polling runner container using a subscription key.
# Usage:
#   just runner KEY [API_URL]
# Example:
#   just runner fr_7c9be939527ec318c61e479c4a5dc3b1 http://192.168.1.50:8000
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

# Push a new ferret-runner image to GHCR (maintainers only).
# Requires docker login to ghcr.io and write access to the repo packages.
# CI runs this automatically on push to main when src/apps/runner/** changes.
publish-runner:
    docker buildx build \
        --platform linux/amd64 \
        -t ghcr.io/synlace/ferret-runner:latest \
        --push \
        src/apps/runner

# Create and push a semver release tag, triggering the GA workflow to publish
# a versioned ferret-runner image to GHCR, and rebuilds the UI image with the
# new version baked in via NEXT_PUBLIC_APP_VERSION.
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
    echo "UI image rebuilt. Run 'just up' or 'docker compose up -d ui' to deploy."

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

    # Resolve the actual container name/ID for ferret-runner (may differ from service name)
    RUNNER_CONTAINER=$(docker compose ps -q runner 2>/dev/null | head -1)
    if [[ -z "$RUNNER_CONTAINER" ]]; then
        echo "ERROR: ferret-runner container not found — is the stack running? (just up)"
        exit 1
    fi

    echo ""
    echo "=== Docker socket proxy integration tests ==="
    echo "    runner container: $RUNNER_CONTAINER"
    echo ""
    echo "--- Allowed operations ---"
    run "container list (CONTAINERS=1)"  yes  ps -q
    run "exec into ferret-runner (EXEC=1)"  yes  exec "$RUNNER_CONTAINER" echo proxy-exec-ok

    echo ""
    echo "--- Blocked operations ---"
    run "image pull (IMAGES not permitted)"          no  pull alpine:latest
    run "volume create (VOLUMES not permitted)"      no  volume create ferret-evil-vol
    run "network create (NETWORKS not permitted)"    no  network create ferret-evil-net

    echo ""
    echo "=== Results: ${PASS} passed, ${FAIL} failed ==="
    [[ $FAIL -eq 0 ]] || exit 1

# Destroy all AWS resources created by the AWS Den (EC2 Hub, SG, IAM, ECS, Logs)
destroy-aws region="eu-west-1":
    #!/usr/bin/env bash
    set -euo pipefail
    TERRAFORM_DIR="$(dirname -- "$(realpath -- "{{justfile()}}")")/terraform"
    if [[ ! -f "${TERRAFORM_DIR}/terraform.tfstate" ]]; then
        echo "[destroy-aws] No Terraform state found at ${TERRAFORM_DIR}/terraform.tfstate — nothing to destroy."
        exit 0
    fi

    # 1. Stop dynamically spawned (boto3) Fargate tasks before Terraform destroy
    if command -v aws &>/dev/null; then
        echo "[destroy-aws] Querying for active boto3-deployed Fargate tasks in cluster 'ferret-runners'..."
        export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-eu-west-1}"
        
        # Get active/pending task ARNs
        TASK_ARNS=$(aws ecs list-tasks --cluster "ferret-runners" --query "taskArns" --output text 2>/dev/null || true)
        
        if [[ -n "$TASK_ARNS" && "$TASK_ARNS" != "None" ]]; then
            echo "[destroy-aws] Active tasks found. Stopping all Fargate runners..."
            for task in $TASK_ARNS; do
                echo "  -> Stopping Fargate task: $task"
                aws ecs stop-task --cluster "ferret-runners" --task "$task" >/dev/null 2>&1 || true
            done
            
            # 2. Block until tasks are fully stopped to ensure ENIs are detached
            echo "[destroy-aws] Waiting for AWS Fargate to fully tear down tasks and detach ENIs..."
            aws ecs wait tasks-stopped --cluster "ferret-runners" --tasks $TASK_ARNS 2>/dev/null || true
            echo "[destroy-aws] All tasks stopped. ENIs detached."
        else
            echo "[destroy-aws] No active Fargate tasks running."
        fi
    else
        echo "[destroy-aws] Warning: AWS CLI not found on host. Dynamic Fargate tasks cannot be auto-killed."
    fi

    # 3. Proceed to destroy Terraform infrastructure (which will now succeed instantly)
    echo "[destroy-aws] Destroying Terraform-managed AWS infrastructure in ${TERRAFORM_DIR}..."
    cd "${TERRAFORM_DIR}"
    terraform init -reconfigure
    terraform destroy -auto-approve
    echo "[destroy-aws] AWS teardown complete."

