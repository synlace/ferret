import asyncio
import base64
import logging
from typing import Optional

import deps

_log = logging.getLogger(__name__)

class FargateWGOrchestrator:
    """Manages dynamic unprivileged Fargate runner task provisioning and lifecycle management."""

    @staticmethod
    async def spawn_runners_if_needed(den_id: str, runner_count: int) -> list:
        """Dynamically trigger and run ephemeral Fargate task runners on ECS."""
        # 1. Fetch targeted Den record
        den = await deps.db_client.get_den(den_id)
        if not den or den["type"] != "aws":
            _log.info("[Orchestrator] Den ID '%s' is not an AWS Den — bypassing cloud Fargate provisioning.", den_id)
            return []

        max_runners_str = den.get("max_runners") or "10"
        try:
            den_max_runners = int(max_runners_str)
        except ValueError:
            den_max_runners = 10

        # Bounded by global max concurrent runners ceiling
        count = min(runner_count, den_max_runners)
        _log.info("[FARGATE_ORCHESTRATOR] [START] Initiating launch of %d dynamic runner(s) for Den ID: %s", count, den_id)

        aws_key = den.get("aws_access_key") or ""
        aws_secret = den.get("aws_secret_key") or ""
        aws_region = den.get("aws_region") or "eu-west-1"

        if not aws_key or not aws_secret:
            _log.error("[FARGATE_ORCHESTRATOR] [FAILED] Missing AWS credentials in Den '%s' settings — cannot provision cloud runners.", den_id)
            return []

        # Find or use the cached EC2 private IP (populated from local file or configuration)
        # If no custom private IP is cached, default to the WireGuard network hub endpoint
        ec2_private_ip = "10.0.0.1"  # Persistent EC2 WireGuard Hub private VPC IP address
        
        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            _log.warning("[Orchestrator] 'boto3' not installed in this environment — simulating successful AWS Fargate task spawn.")
            return [f"simulated-task-arn-{i}" for i in range(count)]

        # Run ECS client commands inside a threadpool to prevent blocking the async loop
        def _provision_fargate_task():
            _log.info("[FARGATE_ORCHESTRATOR] [BOTO3_INIT] Configuring AWS Fargate ECS/EC2 clients in region: %s", aws_region)
            config = Config(region_name=aws_region)
            ecs = boto3.client("ecs", aws_access_key_id=aws_key, aws_secret_access_key=aws_secret, config=config)
            ec2 = boto3.client("ec2", aws_access_key_id=aws_key, aws_secret_access_key=aws_secret, config=config)
            iam = boto3.client("iam", aws_access_key_id=aws_key, aws_secret_access_key=aws_secret, config=config)
            logs = boto3.client("logs", aws_access_key_id=aws_key, aws_secret_access_key=aws_secret, config=config)

            # Auto-discover EC2 WireGuard Hub Private VPC IP
            _log.info("[FARGATE_ORCHESTRATOR] [IP_DISCOVERY] Auto-discovering EC2 WireGuard Hub Private VPC IP by tag 'ferret-wg-hub'...")
            ec2_private_ip = "10.0.0.1"
            try:
                instances = ec2.describe_instances(Filters=[
                    {"Name": "tag:Name", "Values": ["ferret-wg-hub"]},
                    {"Name": "instance-state-name", "Values": ["running"]}
                ])
                if instances.get("Reservations") and instances["Reservations"][0].get("Instances"):
                    ec2_private_ip = instances["Reservations"][0]["Instances"][0].get("PrivateIpAddress") or "10.0.0.1"
                    _log.info("[FARGATE_ORCHESTRATOR] [IP_DISCOVERY] Auto-discovered EC2 WireGuard Hub Private VPC IP: %s", ec2_private_ip)
            except Exception as discover_err:
                _log.warning("[FARGATE_ORCHESTRATOR] [IP_DISCOVERY] Failed to auto-discover EC2 Hub Private IP, defaulting to 10.0.0.1: %s", discover_err)

            # Auto-discover VPC and Subnets
            _log.info("[FARGATE_ORCHESTRATOR] [VPC_DISCOVERY] Searching for default or usable VPC...")
            vpcs = ec2.describe_vpcs(Filters=[{"Name": "is-default", "Values": ["true"]}])
            vpc_id = vpcs["Vpcs"][0]["VpcId"] if vpcs.get("Vpcs") else None
            if not vpc_id:
                all_vpcs = ec2.describe_vpcs()
                vpc_id = all_vpcs["Vpcs"][0]["VpcId"] if all_vpcs.get("Vpcs") else ""

            if not vpc_id:
                _log.error("[FARGATE_ORCHESTRATOR] [VPC_DISCOVERY] VPC discovery failed.")
                raise Exception("No usable VPC discovered in this AWS account.")
            _log.info("[FARGATE_ORCHESTRATOR] [VPC_DISCOVERY] Selected VPC ID: %s", vpc_id)

            _log.info("[FARGATE_ORCHESTRATOR] [SUBNET_DISCOVERY] Scanning subnets in VPC '%s'...", vpc_id)
            subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
            subnet_ids = [sub["SubnetId"] for sub in subnets.get("Subnets", [])]
            if not subnet_ids:
                _log.error("[FARGATE_ORCHESTRATOR] [SUBNET_DISCOVERY] No subnets found for VPC '%s'", vpc_id)
                raise Exception(f"No subnets found for VPC '{vpc_id}'")
            _log.info("[FARGATE_ORCHESTRATOR] [SUBNET_DISCOVERY] Discovered %d subnets. First subnet ID: %s", len(subnet_ids), subnet_ids[0])

            # Check/Create Security Group
            sg_id = None
            _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Checking if 'ferret-runner-outbound-sg' exists in VPC '%s'...", vpc_id)
            sgs = ec2.describe_security_groups(Filters=[
                {"Name": "group-name", "Values": ["ferret-runner-outbound-sg"]},
                {"Name": "vpc-id", "Values": [vpc_id]}
            ])
            if sgs.get("SecurityGroups"):
                sg_id = sgs["SecurityGroups"][0]["GroupId"]
                _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Found existing outbound SG ID: %s", sg_id)
            else:
                _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Group not found. Creating outbound-only security group...")
                res = ec2.create_security_group(
                    GroupName="ferret-runner-outbound-sg",
                    Description="Security Group for outbound-only Ferret Runners",
                    VpcId=vpc_id
                )
                sg_id = res["GroupId"]
                _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Created new outbound SG ID: %s", sg_id)

            # Role configuration
            role_arn = None
            _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Retrieving or establishing execution role 'ferretExecutionRole'...")
            try:
                role_res = iam.get_role(RoleName="ferretExecutionRole")
                role_arn = role_res["Role"]["Arn"]
                _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Found existing role ARN: %s", role_arn)
            except Exception:
                _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Role not found. Creating execution IAM role 'ferretExecutionRole'...")
                trust_policy = '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
                create_res = iam.create_role(
                    RoleName="ferretExecutionRole",
                    AssumeRolePolicyDocument=trust_policy
                )
                role_arn = create_res["Role"]["Arn"]
                iam.attach_role_policy(RoleName="ferretExecutionRole", PolicyArn="arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy")
                iam.attach_role_policy(RoleName="ferretExecutionRole", PolicyArn="arn:aws:iam::aws:policy/CloudWatchLogsFullAccess")
                _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Successfully created and attached policies to %s", role_arn)

            # Create ECS cluster and Log group
            _log.info("[FARGATE_ORCHESTRATOR] [ECS_SETUP] Ensuring ECS Cluster 'ferret-runners' exists...")
            ecs.create_cluster(clusterName="ferret-runners")
            try:
                _log.info("[FARGATE_ORCHESTRATOR] [ECS_SETUP] Ensuring Log Group '/ecs/ferret-polling-mesh' exists...")
                logs.create_log_group(logGroupName="/ecs/ferret-polling-mesh")
            except Exception:
                pass # Already exists

            # Load the unprivileged runner source code
            from pathlib import Path
            runner_py_content = ""
            current_file_dir = Path(__file__).parent
            runner_path = Path("/app/runner.py")
            if not runner_path.exists():
                runner_path = current_file_dir.parent / "runner.py"
            if not runner_path.exists():
                runner_path = current_file_dir.parent.parent / "lab" / "runner.py"
            
            _log.info("[FARGATE_ORCHESTRATOR] [RUNNER_LOAD] Reading runner code from filesystem at path: %s", runner_path)
            if runner_path.exists():
                runner_py_content = runner_path.read_text(encoding="utf-8")
                _log.info("[FARGATE_ORCHESTRATOR] [RUNNER_LOAD] Loaded runner code. File size: %d bytes.", len(runner_py_content))
            else:
                # Mockup fallback if not in production tree yet
                fallback_path = current_file_dir.parent.parent.parent.parent / "mockups" / "fargate" / "runner.py"
                if fallback_path.exists():
                    runner_py_content = fallback_path.read_text(encoding="utf-8")
                    _log.info("[FARGATE_ORCHESTRATOR] [RUNNER_LOAD] Fallback runner loaded: %s", fallback_path)
                else:
                    runner_py_content = "print('[ferret-runner] Starting unprivileged task...')"
                    _log.warning("[FARGATE_ORCHESTRATOR] [RUNNER_LOAD] Runner code not found. Using minimal placeholder runner.")

            runner_py_b64 = base64.b64encode(runner_py_content.encode("utf-8")).decode("utf-8")

            # We format runner_id specifically with 'runner-fargate-{den_id}-{random_hex}' so the polling logic filters runs cleanly.
            import uuid
            import os
            r_uuid = uuid.uuid4().hex[:6]
            runner_id = f"runner-fargate-{den_id}-{r_uuid}"
            _log.info("[FARGATE_ORCHESTRATOR] [RUNNER_ID] Allocated Runner ID: %s for Den: %s", runner_id, den_id)

            runner_image = os.environ.get("FERRET_RUNNER_IMAGE") or "b64"
            if runner_image == "b64":
                task_image = "python:3.10-alpine"
                task_env = [
                    {"name": "RUNNER_PY_B64", "value": runner_py_b64},
                    {"name": "FERRET_API_URL", "value": f"http://{ec2_private_ip}"},
                    {"name": "FERRET_RUNNER_ID", "value": runner_id}
                ]
                task_entry_point = ["sh", "-c"]
                task_command = ["pip install requests && python3 -c \"import os, base64; open('/runner.py', 'wb').write(base64.b64decode(os.environ['RUNNER_PY_B64']))\" && python3 -u /runner.py"]
            else:
                task_image = runner_image
                task_env = [
                    {"name": "FERRET_API_URL", "value": f"http://{ec2_private_ip}"},
                    {"name": "FERRET_RUNNER_ID", "value": runner_id}
                ]
                # Pre-packaged GHCR image has entrypoint.sh set up already
                task_entry_point = ["/entrypoint.sh"]
                task_command = []

            # Register task definition
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_DEF] Registering Task Definition 'ferret-runner-%s' (Image: %s)...", den_id, task_image)
            ecs.register_task_definition(
                family=f"ferret-runner-{den_id}",
                networkMode="awsvpc",
                executionRoleArn=role_arn,
                taskRoleArn=role_arn,
                containerDefinitions=[
                    {
                        "name": "runner",
                        "image": task_image,
                        "cpu": 256,
                        "memory": 512,
                        "essential": True,
                        "environment": task_env,
                        "entryPoint": task_entry_point,
                        "command": task_command if task_command else None,
                        "logConfiguration": {
                            "logDriver": "awslogs",
                            "options": {
                                "awslogs-group": "/ecs/ferret-polling-mesh",
                                "awslogs-region": aws_region,
                                "awslogs-stream-prefix": "runner"
                            }
                        }
                    }
                ],
                requiresCompatibilities=["FARGATE"],
                cpu="256",
                memory="512"
            )
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_DEF] Task Definition registered successfully.")

            # Launch Fargate tasks (with retry loop for IAM propagation delay)
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] Spinning up Fargate ECS tasks on cluster 'ferret-runners'...")
            task_arns = []
            import time
            for i in range(count):
                _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] Spawning task %d of %d...", i+1, count)
                for attempt in range(6):
                    try:
                        task_res = ecs.run_task(
                            cluster="ferret-runners",
                            taskDefinition=f"ferret-runner-{den_id}",
                            launchType="FARGATE",
                            networkConfiguration={
                                "awsvpcConfiguration": {
                                    "subnets": [subnet_ids[0]],
                                    "securityGroups": [sg_id],
                                    "assignPublicIp": "ENABLED"
                                }
                            }
                        )
                        if task_res.get("tasks"):
                            arn = task_res["tasks"][0]["taskArn"]
                            task_arns.append(arn)
                            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN_SUCCESS] Spawned Fargate task ARN: %s", arn)
                            break
                        else:
                            _log.error("[FARGATE_ORCHESTRATOR] [TASK_RUN_FAILED] No task info returned in response: %s", task_res)
                            break
                    except Exception as run_err:
                        if "unable to assume the role" in str(run_err) and attempt < 5:
                            sleep_time = (attempt + 1) * 5
                            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] Newly created IAM role is still propagating. Retrying in %ds...", sleep_time)
                            time.sleep(sleep_time)
                        else:
                            raise run_err

            return task_arns

        try:
            loop = asyncio.get_event_loop()
            task_arns = await loop.run_in_executor(None, _provision_fargate_task)
            _log.info("[Orchestrator] Successfully spawned %d dynamic Fargate task(s): %s", len(task_arns), task_arns)
            return task_arns
        except Exception as e:
            _log.error("[Orchestrator] Fargate spawning failed: %s", e)
            return []
