#!/bin/bash
# Katana Web Crawler Script
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

echo "[ferret] Katana web crawl: $TARGET"
echo "[ferret] Workspace: $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Verify katana is available
# ---------------------------------------------------------------------------
if ! command -v katana &>/dev/null; then
    echo "[ferret] ERROR: katana not found in PATH"
    exit 1
fi

echo "[ferret] katana version: $(katana -version 2>&1 | head -1 || true)"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Crawl the target
# -depth 3      — follow links up to 3 levels deep
# -jc           — enable JavaScript crawling (headless)
# -kf all       — extract all known fields (forms, endpoints, params)
# -silent       — suppress progress output; results go to stdout
# -no-color     — plain text output
# ---------------------------------------------------------------------------
echo "[ferret] Step 1: Crawling $TARGET (depth 3)..."
echo ""

KATANA_OUT="$WORKSPACE/notes/katana_urls.txt"
KATANA_FIELDS="$WORKSPACE/notes/katana_fields.txt"

# Standard crawl — collect all discovered URLs
katana \
    -u "$TARGET" \
    -depth 3 \
    -silent \
    -no-color \
    -o "$KATANA_OUT" \
    2>&1 || true

URL_COUNT=$(wc -l < "$KATANA_OUT" 2>/dev/null || echo 0)
echo "[ferret] Discovered $URL_COUNT URLs"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Extract interesting endpoints (forms, params, JS files, APIs)
# ---------------------------------------------------------------------------
echo "[ferret] Step 2: Extracting interesting endpoints..."

katana \
    -u "$TARGET" \
    -depth 3 \
    -kf all \
    -silent \
    -no-color \
    2>/dev/null | sort -u > "$KATANA_FIELDS" || true

FIELD_COUNT=$(wc -l < "$KATANA_FIELDS" 2>/dev/null || echo 0)
echo "[ferret] Extracted $FIELD_COUNT field entries"
echo ""

# ---------------------------------------------------------------------------
# Step 3: Write structured report
# ---------------------------------------------------------------------------
echo "[ferret] Step 3: Writing report..."

REPORT="$WORKSPACE/notes/katana.md"

python3 - <<PYEOF
import sys, os, re
from urllib.parse import urlparse

target = "$TARGET"
domain = "$DOMAIN"
urls_path = "$KATANA_OUT"
fields_path = "$KATANA_FIELDS"
report_path = "$REPORT"

urls = []
try:
    with open(urls_path) as f:
        urls = [l.strip() for l in f if l.strip()]
except FileNotFoundError:
    pass

fields = []
try:
    with open(fields_path) as f:
        fields = [l.strip() for l in f if l.strip()]
except FileNotFoundError:
    pass

# Categorise URLs
js_files = [u for u in urls if u.endswith(".js") or ".js?" in u]
api_paths = [u for u in urls if re.search(r"/api/|/v\d+/|/graphql|/rest/|/json", u, re.I)]
forms = [u for u in fields if "form" in u.lower()]
params = [u for u in urls if "?" in u]

# Group by path depth
paths = set()
for u in urls:
    try:
        p = urlparse(u).path
        if p and p != "/":
            paths.add(p)
    except Exception:
        pass

with open(report_path, "w") as out:
    out.write(f"# Katana Crawl: {target}\n\n")
    out.write(f"**Target:** {target}\n")
    out.write(f"**Total URLs discovered:** {len(urls)}\n")
    out.write(f"**Unique paths:** {len(paths)}\n")
    out.write(f"**JS files:** {len(js_files)}\n")
    out.write(f"**URLs with parameters:** {len(params)}\n\n")

    if js_files:
        out.write("## JavaScript Files\n\n")
        for u in sorted(js_files)[:50]:
            out.write(f"- `{u}`\n")
        if len(js_files) > 50:
            out.write(f"- _...and {len(js_files) - 50} more_\n")
        out.write("\n")

    if api_paths:
        out.write("## API / Versioned Endpoints\n\n")
        for u in sorted(api_paths)[:50]:
            out.write(f"- `{u}`\n")
        if len(api_paths) > 50:
            out.write(f"- _...and {len(api_paths) - 50} more_\n")
        out.write("\n")

    if params:
        out.write("## URLs with Parameters\n\n")
        for u in sorted(params)[:50]:
            out.write(f"- `{u}`\n")
        if len(params) > 50:
            out.write(f"- _...and {len(params) - 50} more_\n")
        out.write("\n")

    if urls:
        out.write("## All Discovered URLs\n\n")
        out.write("```\n")
        for u in sorted(urls)[:200]:
            out.write(f"{u}\n")
        if len(urls) > 200:
            out.write(f"... and {len(urls) - 200} more (see katana_urls.txt)\n")
        out.write("```\n")
    else:
        out.write("_No URLs discovered._\n")

print(f"[ferret] Report written: {len(urls)} URLs, {len(paths)} unique paths")
PYEOF

echo "[ferret] Report: $REPORT"
echo "[ferret] Full URL list: $KATANA_OUT"
echo ""

# ---------------------------------------------------------------------------
# Step 4: Emit [FERRET:MANIFEST] lines for interesting paths
# Each line creates a child workspace so follow-on plans (e.g. arjun, nuclei)
# can be run against individual paths.
# We emit: API endpoints, URLs with parameters, and JS files.
# ---------------------------------------------------------------------------
echo "[ferret] Step 4: Emitting manifest entries for interesting paths..."

python3 - "$KATANA_OUT" "$TARGET" <<'PYEOF'
import sys, json, re
from urllib.parse import urlparse

urls_path = sys.argv[1]
target = sys.argv[2]

try:
    with open(urls_path) as f:
        urls = [l.strip() for l in f if l.strip()]
except FileNotFoundError:
    urls = []

emitted = 0
seen = set()

for url in urls:
    # Only emit interesting paths: API endpoints, parameterised URLs, JS files
    is_api = bool(re.search(r"/api/|/v\d+/|/graphql|/rest/|/json", url, re.I))
    has_params = "?" in url
    is_js = url.endswith(".js") or ".js?" in url

    if not (is_api or has_params or is_js):
        continue

    if url in seen:
        continue
    seen.add(url)

    manifest = json.dumps({"name": url, "type": "path"})
    print(f"[FERRET:MANIFEST] {manifest}", flush=True)
    emitted += 1

print(f"[ferret] Emitted {emitted} path manifest entries", flush=True)
PYEOF

echo ""
echo "[ferret] Katana crawl complete."
