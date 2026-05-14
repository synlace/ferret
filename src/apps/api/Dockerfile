FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies including Docker CLI for DooD (Docker-out-of-Docker)
# and gosu for privilege dropping in the entrypoint.
RUN apt-get update && apt-get install -y \
    gcc \
    g++ \
    curl \
    ca-certificates \
    gosu \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first for better caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create non-root user and the /data directory for SQLite.
# The entrypoint will dynamically add ferret to the docker socket group at runtime.
RUN useradd -m -u 1000 ferret \
    && mkdir -p /data \
    && chown -R ferret:ferret /app /data

# Copy and configure the entrypoint (runs as root to fix socket GID, then drops to ferret)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose ports
EXPOSE 8000 8080

# Health check (uses stdlib urllib — no extra dependencies required)
HEALTHCHECK --interval=15s --timeout=10s --start-period=10s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Entrypoint runs as root to fix docker socket GID, then drops to ferret via gosu.
ENTRYPOINT ["docker-entrypoint.sh"]

# Start the application without the uvicorn reloader.
# The reloader forks a child process with a separate network namespace;
# the mitmproxy thread binds its port inside that child namespace, making
# it unreachable from docker exec / host port mapping.
# --reload is NOT passed — uvicorn defaults to no-reload.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]