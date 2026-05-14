#!/bin/sh
# Runs as root on startup to:
#   1. Ensure /data is owned by the ferret user (bind mount may be root-owned)
#   2. Dynamically add ferret to the docker socket group for DooD access
# Then drops privileges to ferret via gosu.
set -e

# Fix /data ownership so ferret can write the SQLite DB and test files
chown -R ferret:ferret /data 2>/dev/null || true

# Fix docker socket group membership
if [ -S /var/run/docker.sock ]; then
    SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
    # If the socket is owned by root (GID 0), skip — ferret can't join root group
    if [ "$SOCK_GID" != "0" ]; then
        # Create the group if it doesn't exist, then add ferret to it
        if ! getent group "$SOCK_GID" > /dev/null 2>&1; then
            groupadd -g "$SOCK_GID" dockersock
        fi
        SOCK_GROUP=$(getent group "$SOCK_GID" | cut -d: -f1)
        usermod -aG "$SOCK_GROUP" ferret 2>/dev/null || true
    fi
fi

# Drop privileges and exec the real command as ferret
exec gosu ferret "$@"
