# ferret-lab - lightweight web pentest sandbox for FERRET AI test execution
# The full tool set is preserved in Dockerfile.full for reference.
FROM kalilinux/kali-rolling

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# ── Layer 1: Core system dependencies ────────────────────────────────────────
# Stable, small, changes rarely — always cached first
RUN apt-get update && apt-get install -y \
    sudo \
    python3 \
    python3-pip \
    pipx \
    golang-go \
    curl \
    wget \
    git \
    vim \
    nano \
    ca-certificates \
    ipcalc \
    jq \
    eza \
    just \
    ripgrep \
    python3-watchdog \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Web exploitation tools ──────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    sqlmap \
    nikto \
    gobuster \
    dirb \
    ffuf \
    whatweb \
    mitmproxy \
    wfuzz \
    wpscan \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 3: Network & recon (web-relevant only) ──────────────────────────────
# Removed: masscan, tshark, tcpdump, wireshark-common, tcpflow, enum4linux,
#          responder, smbclient, nfs-common, ldap-utils, aircrack-ng,
#          openvpn, wireguard-tools (none relevant to HTTP/web testing)
RUN apt-get update && apt-get install -y \
    nmap \
    netcat-traditional \
    dnsenum \
    iproute2 \
    proxychains4 \
    sslscan \
    testssl.sh \
    theharvester \
    sublist3r \
    whois \
    dnsutils \
    iputils-ping \
    traceroute \
    net-tools \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Web auth brute force ─────────────────────────────────────────────
# Removed: hashcat, john, crunch, fcrackzip (offline hash cracking, not web)
RUN apt-get update && apt-get install -y \
    hydra \
    medusa \
    cewl \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 5: Useful utilities ─────────────────────────────────────────────────
# Removed: pspy (process spy / CTF tool)
# Removed: binwalk, foremost, steghide (forensics / CTF, not web proxy work)
# Removed: radare2, gdb, ltrace, strace (binary RE, not web)
RUN apt-get update && apt-get install -y \
    socat \
    rlwrap \
    xxd \
    hexedit \
    file \
    binutils \
    tmux \
    screen \
    exiftool \
    sshpass \
    hakrawler \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 5b: SecLists (web-relevant subdirectories only) ────────────────────
# The full seclists apt package is ~1 GB. We sparse-checkout only the paths
# referenced by the AI chat context in chats.py, saving ~900 MB.
RUN git clone --depth 1 --filter=blob:none --sparse \
        https://github.com/danielmiessler/SecLists.git \
        /usr/share/seclists && \
    cd /usr/share/seclists && \
    git sparse-checkout set \
        Discovery/Web-Content \
        Discovery/DNS \
        Usernames \
        "Passwords/Common-Credentials" \
        Fuzzing/SQLi && \
    rm -rf .git

# ── Layer 6: Database clients ─────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    mariadb-client \
    postgresql-client \
    sqlite3 \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 7: Python tooling (sslyze) ─────────────────────────────────────────
ENV PATH="/root/.local/bin:${PATH}"
RUN pipx ensurepath && pipx install sslyze && \
    echo 'export PATH="/root/.local/bin:$PATH"' > /etc/profile.d/pipx-path.sh

# ── Layer 8: Go-based recon tools (lightweight set) ──────────────────────────
# Removed: amass (very heavy build, overlaps entirely with subfinder)
ENV PATH="/root/go/bin:${PATH}"
RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest && \
    go install -v github.com/tomnomnom/assetfinder@latest && \
    echo 'export PATH="/root/go/bin:$PATH"' > /etc/profile.d/go-path.sh

# ── Layer 9: knock (DNS subdomain scanner) ────────────────────────────────────
RUN git clone --depth 1 https://github.com/guelfoweb/knock.git /opt/knock && \
    python3 -m venv /opt/knock-venv && \
    /opt/knock-venv/bin/pip install --quiet /opt/knock && \
    ln -s /opt/knock-venv/bin/knockpy /usr/local/bin/knockpy

# ── Layer 10: Python test/HTTP libraries ─────────────────────────────────────
RUN pip3 install --no-cache-dir --break-system-packages \
    pytest \
    pytest-asyncio \
    requests \
    httpx \
    websockets \
    websocket-client \
    urllib3 \
    cryptography \
    paramiko

# ── Layer 11: Data directory & entrypoint ────────────────────────────────────
RUN mkdir -p /data/tests

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
