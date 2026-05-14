# ferret-lab — Kali Linux pentest sandbox for FERRET AI test execution
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

# ── Layer 3: Network analysis & recon tools ───────────────────────────────────
RUN apt-get update && apt-get install -y \
    nmap \
    masscan \
    netdiscover \
    netcat-traditional \
    tshark \
    tcpdump \
    wireshark-common \
    tcpflow \
    enum4linux \
    dnsenum \
    iproute2 \
    responder \
    smbclient \
    nfs-common \
    ldap-utils \
    whois \
    proxychains4 \
    openvpn \
    wireguard-tools \
    aircrack-ng \
    theharvester \
    sublist3r \
    sslscan \
    testssl.sh \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Password attacks & cryptography ─────────────────────────────────
RUN apt-get update && apt-get install -y \
    hashcat \
    john \
    hydra \
    medusa \
    crunch \
    cewl \
    fcrackzip \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 5: Forensics & steganography ───────────────────────────────────────
RUN apt-get update && apt-get install -y \
    binwalk \
    foremost \
    exiftool \
    steghide \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 6: Reverse engineering & debugging ─────────────────────────────────
RUN apt-get update && apt-get install -y \
    radare2 \
    gdb \
    ltrace \
    strace \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 7: Database clients ─────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    mariadb-client \
    postgresql-client \
    sqlite3 \
    redis-tools \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 8: Exploitation frameworks ─────────────────────────────────────────
# Heaviest layer — isolated so it caches independently
RUN apt-get update && apt-get install -y \
    metasploit-framework \
    impacket-scripts \
    exploitdb \
    evil-winrm \
    crackmapexec \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 9: General utilities ────────────────────────────────────────────────
RUN apt-get update && apt-get install -y \
    socat \
    rlwrap \
    xxd \
    hexedit \
    file \
    binutils \
    dnsutils \
    iputils-ping \
    traceroute \
    net-tools \
    tmux \
    screen \
    seclists \
    pspy \
    sshpass \
    wbritish-small \
    hakrawler \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 10: Python tooling (sslyze + knockpy) ───────────────────────────────
ENV PATH="/root/.local/bin:${PATH}"
RUN pipx ensurepath && pipx install sslyze && \
    echo 'export PATH="/root/.local/bin:$PATH"' > /etc/profile.d/pipx-path.sh

# ── Layer 11: Go-based recon tools ───────────────────────────────────────────
ENV PATH="/root/go/bin:${PATH}"
RUN go install -v github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest && \
    go install -v github.com/tomnomnom/assetfinder@latest && \
    go install -v github.com/owasp-amass/amass/v4/...@master && \
    echo 'export PATH="/root/go/bin:$PATH"' > /etc/profile.d/go-path.sh

# ── Layer 12: knock (DNS subdomain scanner) ───────────────────────────────────
RUN git clone --depth 1 https://github.com/guelfoweb/knock.git /opt/knock && \
    python3 -m venv /opt/knock-venv && \
    /opt/knock-venv/bin/pip install --quiet /opt/knock && \
    ln -s /opt/knock-venv/bin/knockpy /usr/local/bin/knockpy

# ── Layer 13: Python test/HTTP libraries ─────────────────────────────────────
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

# ── Layer 14: Data directory & entrypoint ────────────────────────────────────
RUN mkdir -p /data/tests

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
