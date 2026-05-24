#!/bin/bash
# Nmap Port Scanner Script
# Ferret placeholders substituted at runtime:
#   {{target}}        — target URL or host (e.g. https://example.com or example.com)
#   {{domain}}        — base domain extracted from target (e.g. example.com)
#   {{workspace}}     — absolute path to workspace directory inside sandbox
#   {{workspace_id}}  — workspace UUID
#   {{session_id}}    — run UUID

set -euo pipefail

TARGET="{{target}}"
DOMAIN="{{domain}}"
WORKSPACE="{{workspace}}"

echo "[ferret] Nmap port scan: $TARGET"
echo "[ferret] Host: $DOMAIN"
echo "[ferret] Workspace: $WORKSPACE"
echo ""

mkdir -p "$WORKSPACE/notes"

# ---------------------------------------------------------------------------
# Verify nmap is available
# ---------------------------------------------------------------------------
if ! command -v nmap &>/dev/null; then
    echo "[ferret] ERROR: nmap not found in PATH"
    exit 1
fi

echo "[ferret] nmap version: $(nmap --version 2>&1 | head -1 || true)"
echo ""

# ---------------------------------------------------------------------------
# Step 1: Fast top-1000 port scan with service/version detection
# -sV       — service version detection
# -sC       — default scripts (safe category only)
# -T4       — aggressive timing (faster, suitable for recon)
# --open    — only show open ports
# -oX       — XML output for structured parsing
# ---------------------------------------------------------------------------
echo "[ferret] Step 1: Top-1000 port scan with service detection..."
echo ""

NMAP_XML="$WORKSPACE/notes/nmap_scan.xml"
NMAP_TXT="$WORKSPACE/notes/nmap_scan.txt"

nmap \
    -sV \
    -sC \
    -T4 \
    --open \
    -oX "$NMAP_XML" \
    -oN "$NMAP_TXT" \
    "$DOMAIN" \
    2>&1 || true

echo ""
echo "[ferret] Scan output: $NMAP_TXT"
echo ""

# ---------------------------------------------------------------------------
# Step 2: Parse XML output and write structured report
# ---------------------------------------------------------------------------
echo "[ferret] Step 2: Writing report..."

REPORT="$WORKSPACE/notes/nmap.md"

python3 - <<PYEOF
import sys, os

try:
    import xml.etree.ElementTree as ET
except ImportError:
    print("[ferret] ERROR: xml.etree.ElementTree not available")
    sys.exit(1)

target = "$TARGET"
domain = "$DOMAIN"
xml_path = "$NMAP_XML"
txt_path = "$NMAP_TXT"
report_path = "$REPORT"

hosts = []

try:
    tree = ET.parse(xml_path)
    root = tree.getroot()

    for host_el in root.findall("host"):
        host_info = {"addresses": [], "hostnames": [], "ports": [], "os": []}

        for addr in host_el.findall("address"):
            host_info["addresses"].append({
                "addr": addr.get("addr", ""),
                "addrtype": addr.get("addrtype", ""),
            })

        hostnames_el = host_el.find("hostnames")
        if hostnames_el is not None:
            for hn in hostnames_el.findall("hostname"):
                host_info["hostnames"].append(hn.get("name", ""))

        ports_el = host_el.find("ports")
        if ports_el is not None:
            for port_el in ports_el.findall("port"):
                state_el = port_el.find("state")
                if state_el is None or state_el.get("state") != "open":
                    continue
                service_el = port_el.find("service")
                port_data = {
                    "portid": port_el.get("portid", ""),
                    "protocol": port_el.get("protocol", ""),
                    "state": state_el.get("state", ""),
                    "service": service_el.get("name", "") if service_el is not None else "",
                    "product": service_el.get("product", "") if service_el is not None else "",
                    "version": service_el.get("version", "") if service_el is not None else "",
                    "extrainfo": service_el.get("extrainfo", "") if service_el is not None else "",
                    "scripts": [],
                }
                for script_el in port_el.findall("script"):
                    port_data["scripts"].append({
                        "id": script_el.get("id", ""),
                        "output": script_el.get("output", ""),
                    })
                host_info["ports"].append(port_data)

        os_el = host_el.find("os")
        if os_el is not None:
            for osmatch in os_el.findall("osmatch"):
                host_info["os"].append({
                    "name": osmatch.get("name", ""),
                    "accuracy": osmatch.get("accuracy", ""),
                })

        hosts.append(host_info)

except FileNotFoundError:
    pass
except ET.ParseError as e:
    print(f"[ferret] WARNING: could not parse nmap XML: {e}")

total_open = sum(len(h["ports"]) for h in hosts)

with open(report_path, "w") as out:
    out.write(f"# Nmap Scan: {target}\n\n")
    out.write(f"**Target:** {target}\n")
    out.write(f"**Host:** {domain}\n")
    out.write(f"**Open ports found:** {total_open}\n\n")

    if not hosts:
        # Fall back to raw text output
        out.write("_XML parse failed or no hosts found. See raw scan output below._\n\n")
        try:
            with open(txt_path) as f:
                out.write("```\n")
                out.write(f.read())
                out.write("```\n")
        except FileNotFoundError:
            out.write("_No scan output available._\n")
    else:
        for h in hosts:
            addrs = ", ".join(a["addr"] for a in h["addresses"])
            hostnames = ", ".join(h["hostnames"]) if h["hostnames"] else domain
            out.write(f"## Host: {hostnames} ({addrs})\n\n")

            if h["os"]:
                best_os = h["os"][0]
                out.write(f"**OS guess:** {best_os['name']} (accuracy: {best_os['accuracy']}%)\n\n")

            if h["ports"]:
                out.write("### Open Ports\n\n")
                out.write("| Port | Protocol | Service | Version | Info |\n")
                out.write("|------|----------|---------|---------|------|\n")
                for p in sorted(h["ports"], key=lambda x: int(x["portid"]) if x["portid"].isdigit() else 0):
                    version = " ".join(filter(None, [p["product"], p["version"], p["extrainfo"]])).strip()
                    out.write(f"| {p['portid']} | {p['protocol']} | {p['service']} | {version} | |\n")
                out.write("\n")

                # Script output
                for p in h["ports"]:
                    for script in p["scripts"]:
                        if script["output"].strip():
                            out.write(f"#### Port {p['portid']} — Script: `{script['id']}`\n\n")
                            out.write("```\n")
                            out.write(script["output"].strip())
                            out.write("\n```\n\n")
            else:
                out.write("_No open ports found._\n\n")

print(f"[ferret] Report written: {total_open} open ports across {len(hosts)} host(s)")
PYEOF

echo "[ferret] Report: $REPORT"
echo "[ferret] Raw scan: $NMAP_TXT"
echo ""
echo "[ferret] Nmap scan complete."
