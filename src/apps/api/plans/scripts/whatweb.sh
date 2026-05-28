#!/bin/bash
# WhatWeb Fingerprinting Script
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

echo "[ferret] WhatWeb fingerprinting: $TARGET"
echo "[ferret] Workspace: $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Verify whatweb is available
# ---------------------------------------------------------------------------
if ! command -v whatweb &>/dev/null; then
    echo "[ferret] ERROR: whatweb not found in PATH"
    exit 1
fi

echo "[ferret] whatweb version: $(whatweb --version 2>&1 | head -1 || true)"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Run whatweb with verbose output (aggression level 1 — passive)
# Level 1 makes a single request per URL; safe for recon.
# ---------------------------------------------------------------------------
echo "[ferret] Step 1: Running whatweb (aggression 1 — passive)..."

WHATWEB_JSON="$WORKSPACE/notes/whatweb_raw.json"
WHATWEB_LOG="/tmp/ferret_whatweb_$$.log"

whatweb \
    --aggression 1 \
    --log-json="$WHATWEB_JSON" \
    --log-verbose="$WHATWEB_LOG" \
    --no-errors \
    --quiet \
    "$TARGET" 2>&1 || true

echo "[ferret] Raw JSON output: $WHATWEB_JSON"
echo "[ferret] Verbose log: $WHATWEB_LOG"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Also capture human-readable stdout output
# ---------------------------------------------------------------------------
echo "[ferret] Step 2: Human-readable scan output..."
echo ""

whatweb \
    --aggression 1 \
    --no-errors \
    --color=never \
    "$TARGET" 2>&1 || true

echo ""

# ---------------------------------------------------------------------------
# Step 3: Parse JSON output and write structured report
# ---------------------------------------------------------------------------
echo "[ferret] Step 3: Writing report..."

REPORT="$WORKSPACE/notes/whatweb.md"

export TARGET DOMAIN WHATWEB_JSON REPORT

python3 - <<'PYEOF'
import json, sys, os

target = os.environ.get("TARGET", "")
domain = os.environ.get("DOMAIN", "")
json_path = os.environ.get("WHATWEB_JSON", "")
report_path = os.environ.get("REPORT", "")

plugins = {}
status_code = None
request_config = {}

try:
    with open(json_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                # whatweb JSON format: list of [url, {plugins: {...}, ...}]
                # or a dict with target/plugins keys depending on version
                if isinstance(entry, list) and len(entry) >= 2:
                    plugins = entry[1].get("plugins", {})
                    status_code = entry[1].get("http_status", None)
                elif isinstance(entry, dict):
                    plugins = entry.get("plugins", {})
                    status_code = entry.get("http_status", None)
            except Exception:
                pass
except FileNotFoundError:
    print(f"[ferret] WARNING: JSON output file not found: {json_path}", file=sys.stderr)
except Exception as e:
    print(f"[ferret] WARNING: could not parse JSON output: {e}", file=sys.stderr)

lines = []
lines.append(f"**Target:** {target}")
if status_code:
    lines.append(f"**HTTP Status:** {status_code}")
lines.append("")

if plugins:
    lines.append("## Detected Technologies")
    lines.append("")

    # Group plugins by category for readability
    interesting = {}
    for name, data in sorted(plugins.items()):
        if isinstance(data, dict):
            version = data.get("version", [])
            string = data.get("string", [])
            account = data.get("account", [])
            os_val = data.get("os", [])

            details = []
            if version:
                v = version if isinstance(version, str) else ", ".join(str(v) for v in version)
                details.append(f"v{v}")
            if string:
                s = string if isinstance(string, str) else ", ".join(str(s) for s in string[:3])
                details.append(s)
            if account:
                a = account if isinstance(account, str) else ", ".join(str(a) for a in account)
                details.append(f"account: {a}")
            if os_val:
                o = os_val if isinstance(os_val, str) else ", ".join(str(o) for o in os_val)
                details.append(f"os: {o}")

            detail_str = f" ({', '.join(details)})" if details else ""
            interesting[name] = detail_str
        else:
            interesting[name] = ""

    for name, detail in interesting.items():
        lines.append(f"- **{name}**{detail}")

    lines.append("")
else:
    lines.append("_No plugin data parsed from JSON output._")
    lines.append("")
    lines.append("Check \`whatweb_raw.json\` for raw output.")
    lines.append("")

with open(report_path, "w") as f:
    f.write("\n".join(lines) + "\n")

print(f"[ferret] Report written: {report_path}")
print(f"[ferret] Plugins detected: {len(plugins)}")
PYEOF

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
rm -f "$WHATWEB_LOG" 2>/dev/null || true

echo ""
echo "[ferret] WhatWeb fingerprinting complete."
