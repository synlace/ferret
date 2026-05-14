#!/bin/bash
# Install the FERRET proxy CA cert into the system trust store so that
# pytest tests routed through the proxy don't fail with SSL errors.
# The cert is written by mitmproxy into the shared db_data volume at
# /data/mitmproxy/ (persisted across container rebuilds).
CERT_SRC="/data/mitmproxy/mitmproxy-ca-cert.pem"
CERT_DST="/usr/local/share/ca-certificates/ferret-proxy-ca.crt"

if [ -f "$CERT_SRC" ]; then
    cp "$CERT_SRC" "$CERT_DST"
    update-ca-certificates --fresh 2>/dev/null || true
    echo "[ferret-lab] Installed FERRET proxy CA cert into system trust store."
else
    echo "[ferret-lab] Proxy CA cert not found at $CERT_SRC — skipping trust store install."
    echo "[ferret-lab] Start the FERRET proxy at least once to generate the cert."
fi

exec tail -f /dev/null
