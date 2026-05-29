# ADR 0001: Self-Healing and Cost-Optimized Hybrid Fargate-EC2 Network Bridge

## Status
Proposed

## Context
Ferret utilizes a hybrid scanning architecture:
1. A persistent, lightweight AWS EC2 instance (`t3.nano`) runs WireGuard and Nginx to act as a Layer-3 Network Bridge.
2. Transient AWS Fargate runner containers poll the local, on-premises API via this persistent bridge over standard HTTP.
3. This eliminates scan-startup latency and avoids requiring privileged container capabilities (`NET_ADMIN`) on AWS Fargate.

### Problem
The EC2 bridge remains online 24/7, even when the local API is offline, incurring continuous compute and public IPv4 address costs (~$7.40/month per Den environment). 
While we can design the local API to issue `start_instances` and `stop_instances` via `boto3` on clean startup/shutdown, ungraceful local API offline events (e.g., crashes, power losses, laptop lid sleep, internet drops) will leave the EC2 instance orphaned in a running state.

Furthermore, if the EC2 instance shuts itself down during an outage, transient VPN disconnects or network blips could cause the tunnel to remain permanently broken until manual operator intervention.

## Decision
We will implement a **Dual-Sided, Self-Healing Lifecycle Automation** between the local API and the AWS EC2 WireGuard Hub:

### 1. Hub-Side Self-Shutdown (Auto-Stop on Idle)
The EC2 instance will run a cron-scheduled liveness script every minute to monitor WireGuard tunnel handshake activity and HTTP health of the local API. 
* If no active WireGuard handshake has succeeded in the last 15 minutes AND the local API is unreachable via the bridge, the EC2 instance will issue an OS-level `poweroff`.
* An OS-level shutdown of an EBS-backed AWS EC2 instance transitions it safely to a `stopped` state, terminating compute charges.

### 2. API-Side Auto-Recovery (Keep-Alive Daemon)
The local API will run a lightweight, non-blocking background thread or `asyncio` task (`infra_keepalive_loop`) every 5 minutes.
* This daemon will query the AWS EC2 instance state via `boto3` (`ec2.describe_instances`).
* If the instance is in a `stopped` or `stopping` state, the local API will automatically issue `start_instances` to boot the bridge back up, restoring the WireGuard link.

### 3. Elastic IP (EIP) Allocation
We will attach an AWS Elastic IP (EIP) to the EC2 Hub so that the public IP remains static across stop/start cycles. Fargate tasks will point to this static EIP, avoiding dynamic DNS/IP propagation latency.

## Technical Specifications

### A. EC2-Side Liveness Script (Provisioned via Cloud-Init UserData in `terraform/main.tf`)
```bash
cat <<'EOF' > /usr/local/bin/check_api_liveness.sh
#!/bin/bash
set -e

# Target local API over the WireGuard Tunnel
TARGET_URL="http://10.0.0.2:8000/api/health"
FAIL_FILE="/tmp/api_fail_count"

# Check active handshake (15 minutes threshold)
LAST_HANDSHAKE=$(wg show wg0 latest-handshakes | awk '{print $2}')
NOW=$(date +%s)

if [ -n "$LAST_HANDSHAKE" ] && [ "$LAST_HANDSHAKE" -ne 0 ]; then
    TIME_DIFF=$((NOW - LAST_HANDSHAKE))
    if [ "$TIME_DIFF" -lt 900 ]; then
         # Tunnel is healthy and active
         echo "0" > "$FAIL_FILE"
         exit 0
    fi
fi

# Fallback: Check HTTP endpoint
if curl -s --max-time 5 "$TARGET_URL" > /dev/null; then
    echo "0" > "$FAIL_FILE"
else
    # Connection failed, increment failure counter
    VAL=$(cat "$FAIL_FILE" 2>/dev/null || echo "0")
    VAL=$((VAL + 1))
    echo "$VAL" > "$FAIL_FILE"
    
    if [ "$VAL" -ge 10 ]; then
        echo "API and WireGuard Handshake inactive. Stopping EC2 Hub..."
        sudo poweroff
    fi
fi
EOF

chmod +x /usr/local/bin/check_api_liveness.sh
echo "* * * * * root /usr/local/bin/check_api_liveness.sh >> /var/log/api_liveness.log 2>&1" >> /etc/crontab
```

### B. API-Side Keep-Alive Loop (Python background task)
```python
async def start_infra_keepalive_loop(instance_id: str, interval_seconds: int = 300):
    ec2 = boto3.client('ec2')
    while True:
        try:
            resp = await asyncio.to_thread(ec2.describe_instances, InstanceIds=[instance_id])
            state = resp['Reservations'][0]['Instances'][0]['State']['Name']
            
            if state in ['stopped', 'stopping']:
                await asyncio.to_thread(ec2.start_instances, InstanceIds=[instance_id])
        except Exception as e:
            pass # Suppress temporary local internet outage errors
        await asyncio.sleep(interval_seconds)
```

## Consequences

### Positive
* **Zero Persistent Costs:** When the local machine is offline/shutdown, AWS compute charges drop to $0.00. 
* **Self-Healing:** Recovers automatically from network dropouts, temporary VPN handshake failures, and laptop sleep cycles within 5 minutes.
* **Preserves Sandbox Isolation:** Continues using standard, low-privilege Fargate runner containers without requiring complex kernel capabilities or local tunneling tools.

### Negative
* **Startup Latency:** If starting the local API from a fully stopped state, there will be a 1-to-2 minute cold-boot latency while the AWS EC2 instance boots up, starts WireGuard/Nginx, and establishes the tunnel. (This latency is skipped for subsequent scans while the API remains online).
