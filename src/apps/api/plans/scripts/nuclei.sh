#!/bin/bash
# Nuclei Vulnerability Scanner Script
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

echo "[ferret] Nuclei vulnerability scan: $TARGET"
echo "[ferret] Workspace: $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Verify nuclei is available
# ---------------------------------------------------------------------------
if ! command -v nuclei &>/dev/null; then
    echo "[ferret] ERROR: nuclei not found in PATH"
    exit 1
fi

echo "[ferret] nuclei version: $(nuclei -version 2>&1 | head -1 || true)"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Run nuclei with a broad but safe template set
# Tags cover common exposures, misconfigurations, default credentials,
# subdomain takeover, and CVEs — all read-only checks.
# ---------------------------------------------------------------------------
echo "[ferret] Step 1: Running nuclei scan..."
echo "[ferret] Tags: exposure, misconfig, default-login, takeover, cve, tech"
echo ""

NUCLEI_JSON="$WORKSPACE/notes/nuclei_raw.jsonl"
NUCLEI_TXT="$WORKSPACE/notes/nuclei_findings.txt"

nuclei \
    -u "$TARGET" \
    -tags "exposure,misconfig,default-login,takeover,cve,tech" \
    -severity "info,low,medium,high,critical" \
    -no-color \
    -silent \
    -jsonl \
    -o "$NUCLEI_JSON" \
    2>&1 || true

# Also write human-readable output
nuclei \
    -u "$TARGET" \
    -tags "exposure,misconfig,default-login,takeover,cve,tech" \
    -severity "info,low,medium,high,critical" \
    -no-color \
    2>&1 | tee "$NUCLEI_TXT" || true

echo ""

# ---------------------------------------------------------------------------
# Step 2: Parse results and write structured report
# ---------------------------------------------------------------------------
echo "[ferret] Step 2: Writing report..."

REPORT="$WORKSPACE/notes/nuclei.md"

export TARGET DOMAIN NUCLEI_JSON REPORT

python3 - <<'PYEOF'
import json, sys, os

target = os.environ.get("TARGET", "")
domain = os.environ.get("DOMAIN", "")
jsonl_path = os.environ.get("NUCLEI_JSON", "")
report_path = os.environ.get("REPORT", "")

findings = []
severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4, "unknown": 5}

try:
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                findings.append(entry)
            except Exception:
                pass
except FileNotFoundError:
    pass

findings.sort(key=lambda x: severity_order.get(x.get("info", {}).get("severity", "unknown"), 5))

counts = {}
for f in findings:
    sev = f.get("info", {}).get("severity", "unknown")
    counts[sev] = counts.get(sev, 0) + 1

with open(report_path, "w") as out:
    out.write(f"# Nuclei Scan: {target}\n\n")
    out.write(f"**Target:** {target}\n")
    out.write(f"**Total findings:** {len(findings)}\n\n")

    if counts:
        out.write("## Summary\n\n")
        for sev in ["critical", "high", "medium", "low", "info"]:
            if sev in counts:
                out.write(f"- **{sev.capitalize()}:** {counts[sev]}\n")
        out.write("\n")

    if findings:
        out.write("## Findings\n\n")
        for f in findings:
            info = f.get("info", {})
            name = info.get("name", "Unknown")
            sev = info.get("severity", "unknown").upper()
            template_id = f.get("template-id", "")
            matched = f.get("matched-at", target)
            desc = info.get("description", "")
            tags = ", ".join(info.get("tags", []))

            out.write(f"### [{sev}] {name}\n\n")
            if template_id:
                out.write(f"- **Template:** `{template_id}`\n")
            out.write(f"- **Matched:** `{matched}`\n")
            if tags:
                out.write(f"- **Tags:** {tags}\n")
            if desc:
                out.write(f"- **Description:** {desc}\n")
            out.write("\n")
    else:
        out.write("_No findings._\n")

print(f"[ferret] Report written: {len(findings)} findings")
PYEOF

echo "[ferret] Report: $REPORT"
echo ""
echo "[ferret] Nuclei scan complete."
