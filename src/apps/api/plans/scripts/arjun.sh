#!/bin/bash
# Arjun HTTP Parameter Discovery Script
# Ferret placeholders substituted at runtime:
#   {{target}}        — target URL (e.g. https://example.com)
#   {{domain}}        — base domain extracted from target (e.g. example.com)
#   {{workspace}}     — absolute path to workspace directory inside sandbox
#   {{workspace_id}}  — workspace UUID
#   {{session_id}}    — run UUID

set -euo pipefail

TARGET="{{target}}"
DOMAIN="{{domain}}"
WORKSPACE="{{workspace}}"

echo "[ferret] Arjun HTTP parameter discovery: $TARGET"
echo "[ferret] Workspace: $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Verify arjun is available
# ---------------------------------------------------------------------------
if ! command -v arjun &>/dev/null; then
    echo "[ferret] ERROR: arjun not found in PATH"
    echo "[ferret] Install with: pip install arjun"
    exit 1
fi

echo "[ferret] arjun version: $(arjun --version 2>&1 | head -1 || true)"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Run Arjun parameter discovery
# -u        — target URL
# -oJ       — output results as JSON
# -t 10     — 10 concurrent threads
# --stable  — reduce false positives (slower but more accurate)
# ---------------------------------------------------------------------------
echo "[ferret] Step 1: Discovering HTTP parameters on $TARGET..."
echo ""

ARJUN_JSON="$WORKSPACE/notes/arjun_raw.json"

arjun \
    -u "$TARGET" \
    -oJ "$ARJUN_JSON" \
    -t 10 \
    --stable \
    2>&1 || true

echo ""

# ---------------------------------------------------------------------------
# Step 2: Parse results and write markdown report
# ---------------------------------------------------------------------------
echo "[ferret] Step 2: Generating report..."

REPORT="$WORKSPACE/notes/arjun.md"

python3 - "$ARJUN_JSON" "$REPORT" "$TARGET" <<'PYEOF'
import json, os, sys

arjun_json = sys.argv[1]
report_path = sys.argv[2]
target = sys.argv[3]

lines = ["# Arjun Parameter Discovery\n\n", f"**Target:** {target}\n\n"]

if not os.path.exists(arjun_json):
    lines.append("No output file produced — arjun may have found no parameters or encountered an error.\n")
else:
    try:
        with open(arjun_json) as f:
            data = json.load(f)
    except Exception as e:
        lines.append(f"Failed to parse arjun output: {e}\n")
        data = {}

    if not data:
        lines.append("No parameters discovered.\n")
    else:
        total = 0
        for url, methods in data.items():
            lines.append(f"## {url}\n\n")
            for method, params in methods.items():
                if params:
                    total += len(params)
                    lines.append(f"### {method.upper()}\n\n")
                    lines.append("| Parameter |\n|---|\n")
                    for p in sorted(params):
                        lines.append(f"| `{p}` |\n")
                    lines.append("\n")
        if total == 0:
            lines.append("No parameters discovered.\n")
        else:
            lines.insert(2, f"**Parameters found:** {total}\n\n")

with open(report_path, "w") as f:
    f.writelines(lines)

print(f"[ferret] Report written: {report_path}")
PYEOF

echo ""
echo "[ferret] Arjun scan complete."
echo "[ferret] Raw JSON: $ARJUN_JSON"
echo "[ferret] Report:   $REPORT"
