#!/bin/bash
# Passive Subdomain Enumeration Script
# Uses subfinder only — no active probing, no DNS brute-force.
# Ferret placeholders substituted at runtime:
#   {{domain}}          — base domain (e.g. hilton.com)
#   {{target}}          — original target (e.g. *.hilton.com)
#   {{workspace}}       — absolute path to workspace directory inside sandbox
#   {{workspace_id}}    — workspace UUID
#   {{project_id}}      — project UUID
#   {{session_id}}      — run UUID
#   {{follow_on_plan}}  — first follow-on plan ID (empty string if not set)

set -euo pipefail

DOMAIN="{{domain}}"
TARGET="{{target}}"
WORKSPACE="{{workspace}}"
FOLLOW_ON_PLAN="{{follow_on_plan}}"

echo "[ferret] Passive subdomain enumeration for: $DOMAIN"
echo "[ferret] Target: $TARGET"
echo "[ferret] Workspace: $WORKSPACE"
[ -n "$FOLLOW_ON_PLAN" ] && echo "[ferret] Follow-on plan: $FOLLOW_ON_PLAN"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Helper: emit a [FERRET:MANIFEST] line for a discovered host.
# The background runner creates the child workspace immediately.
# ---------------------------------------------------------------------------
emit_manifest() {
    local host="$1"
    local files_json="${2:-{\}}"
    local runs_json=""

    if [ -n "$FOLLOW_ON_PLAN" ]; then
        runs_json=",\"runs\":[{\"plan_id\":\"${FOLLOW_ON_PLAN}\",\"target_url\":\"https://${host}\"}]"
    fi

    echo "[FERRET:MANIFEST] {\"name\":\"${host}\",\"files\":${files_json}${runs_json}}"
}

# ---------------------------------------------------------------------------
# Step 1: Passive enumeration via subfinder
# ---------------------------------------------------------------------------
echo "[ferret] Running subfinder (passive only)..."
COUNT=0

if command -v subfinder &>/dev/null; then
    SUBFINDER_STDERR="/tmp/ferret_subfinder_err_$$.txt"
    while IFS= read -r host; do
        [ -z "$host" ] && continue
        emit_manifest "$host"
        COUNT=$((COUNT + 1))
    done < <(subfinder -d "$DOMAIN" -silent 2>"$SUBFINDER_STDERR" || true)

    echo "[ferret] subfinder found $COUNT subdomains"

    if [ -s "$SUBFINDER_STDERR" ]; then
        echo "[ferret] subfinder stderr:"
        cat "$SUBFINDER_STDERR"
    fi
    rm -f "$SUBFINDER_STDERR" 2>/dev/null || true
else
    echo "[ferret] ERROR: subfinder not found in PATH"
    exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Write summary report
# ---------------------------------------------------------------------------
echo ""
echo "[ferret] Writing report..."

REPORT="$WORKSPACE/notes/subdomains.md"
cat > "$REPORT" <<MDEOF
# Passive Subdomain Enumeration: $DOMAIN

**Target:** $TARGET
**Tool:** subfinder (passive only)
**Subdomains discovered:** $COUNT

## Discovered Subdomains

MDEOF

if command -v subfinder &>/dev/null; then
    subfinder -d "$DOMAIN" -silent 2>/dev/null >> "$REPORT" || true
fi

echo "[ferret] Report written to: $REPORT"
echo ""
echo "[ferret] Passive subdomain enumeration complete. Found $COUNT subdomains."
