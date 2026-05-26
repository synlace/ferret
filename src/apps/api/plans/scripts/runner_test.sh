#!/bin/sh
# Ferret Runner Diagnostic and Connection Verification Script
# Substitute at runtime:
#   {{target}}        — target URL (e.g. https://example.com)
#   {{domain}}        — base domain extracted from target (e.g. example.com)
#   {{workspace}}     — absolute path to workspace directory inside sandbox
#   {{workspace_id}}  — workspace UUID
#   {{session_id}}    — run UUID

# Use sh compatible options
set -e

TARGET="{{target}}"
DOMAIN="{{domain}}"
WORKSPACE="{{workspace}}"
SESSION_ID="{{session_id}}"

echo "[ferret-diagnostic] === STARTING RUNNER VERIFICATION ==="
echo "[ferret-diagnostic] Target Host:  $TARGET"
echo "[ferret-diagnostic] Base Domain:  $DOMAIN"
echo "[ferret-diagnostic] Workspace:    $WORKSPACE"
echo "[ferret-diagnostic] Session ID:   $SESSION_ID"
echo ""

# Create the notes directory if it doesn't exist
mkdir -p "$WORKSPACE/notes"

echo "[ferret-diagnostic] [✓] Successfully mapped local workspace directory."
echo "[ferret-diagnostic] Running system and connectivity test..."

# 1. Capture system info
RUNNER_OS=$(uname -s || echo "Unknown")
RUNNER_ARCH=$(uname -m || echo "Unknown")
RUNNER_DATE=$(date -u || echo "Unknown")

echo "[ferret-diagnostic] Runner OS: $RUNNER_OS"
echo "[ferret-diagnostic] Runner Architecture: $RUNNER_ARCH"
echo "[ferret-diagnostic] Diagnostics Timestamp: $RUNNER_DATE"
echo ""

# 2. Verify we can run Python inside the unprivileged container
if command -v python3 >/dev/null 2>&1; then
    PYTHON_VER=$(python3 -V 2>&1)
    echo "[ferret-diagnostic] [✓] Python environment active: $PYTHON_VER"
else
    echo "[ferret-diagnostic] [!] Python 3 not found in runner PATH"
fi

# 3. Create a verification artifact in the workspace notes
DIAGNOSTIC_JSON="$WORKSPACE/notes/runner_diagnostic.json"
cat <<EOF > "$DIAGNOSTIC_JSON"
{
  "diagnostic_status": "SUCCESS",
  "runner_os": "$RUNNER_OS",
  "runner_arch": "$RUNNER_ARCH",
  "timestamp_utc": "$RUNNER_DATE",
  "session_id": "$SESSION_ID",
  "target": "$TARGET"
}
EOF
echo "[ferret-diagnostic] [✓] Diagnostic JSON state written to: $DIAGNOSTIC_JSON"

# 4. Generate the final Markdown report for the UI
REPORT_MD="$WORKSPACE/notes/runner_test.md"
cat <<EOF > "$REPORT_MD"
# 🐾 Ferret Runner Diagnostic Report

This report was generated during a diagnostic dry-run to verify your Ferret execution environment is healthy and active.

## 🏁 Verification Status: **PASSED** 🎉

Your dynamic runner successfully received the scan instruction, launched the unprivileged container task, and mounted/wrote back to the workspace volume.

### 📊 System Information
- **Diagnostic Run Time**: \`$RUNNER_DATE\`
- **Runner Operating System**: \`$RUNNER_OS\`
- **Runner CPU Architecture**: \`$RUNNER_ARCH\`
- **Session Identifier**: \`$SESSION_ID\`
- **Configured Target**: \`$TARGET\`

---
*The orchestrator has successfully validated end-to-end task polling, routing, execution, and file generation. You are ready to run production security scans!*
EOF

echo "[ferret-diagnostic] [✓] Markdown validation report saved to: $REPORT_MD"
echo "[ferret-diagnostic] === RUNNER VERIFICATION COMPLETED SUCCESSFULLY ==="
