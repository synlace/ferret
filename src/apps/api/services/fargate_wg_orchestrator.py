import asyncio
import logging
from typing import Optional

import deps

_log = logging.getLogger(__name__)

class FargateWGOrchestrator:
    """Manages dynamic unprivileged Fargate runner task provisioning and lifecycle management."""

    @staticmethod
    async def ensure_runner_capacity(den_id: str, needed_count: int = 1, is_warm: bool = False) -> list:
        """Evaluates active/provisioning vs busy runner headroom for a Den,
        and dynamically provisions additional runners to satisfy the requirement.
        """
        from services.workflow_logging import ctx_project_id, ctx_workspace_id, ctx_workflow_id, ctx_run_id
        ctx_project_id.set("system")
        ctx_workspace_id.set("system")
        ctx_workflow_id.set(f"fargate_{den_id}")
        ctx_run_id.set("system")

        # Fetch targeted Den record first to check if AWS
        den = await deps.db_client.get_den(den_id)
        if not den or den["type"] != "aws":
            return []

        den_live_count = await deps.db_client.get_live_runner_count_for_den(den_id)
        busy_count = await deps.db_client.get_busy_runner_count_for_den(den_id)
        idle_count = den_live_count - busy_count

        if idle_count < needed_count:
            additional_needed = needed_count - idle_count
            _log.info("[FARGATE_ORCHESTRATOR] [CAPACITY] Den '%s' has %d idle runners (Live: %d, Busy: %d). Needed: %d. Spawning %d more...", den_id, idle_count, den_live_count, busy_count, needed_count, additional_needed)
            return await FargateWGOrchestrator.spawn_runners_if_needed(den_id, additional_needed, is_warm=is_warm)
        return []

    @staticmethod
    async def spawn_runners_if_needed(den_id: str, runner_count: int, is_warm: bool = False) -> list:
        """Dynamically trigger and run ephemeral Fargate task runners on ECS.
        
        Args:
            den_id: The Den ID to spawn runners for.
            runner_count: How many runners to spawn.
            is_warm: True for warm pool runners (no idle timeout). False for single-use job runners.
        """
        from services.workflow_logging import ctx_project_id, ctx_workspace_id, ctx_workflow_id, ctx_run_id
        ctx_project_id.set("system")
        ctx_workspace_id.set("system")
        ctx_workflow_id.set(f"fargate_{den_id}")
        ctx_run_id.set("system")

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

        # Count currently active+provisioning registered runners for this specific Den
        # Provisioning runners are pre-registered at ECS task launch time (before they boot),
        # so they immediately count against the ceiling — preventing the spawning storm.
        current_active_count = await deps.db_client.get_live_runner_count_for_den(den_id)

        # Bounded by global max concurrent runners ceiling (subtracting already active runners)
        count = min(runner_count, den_max_runners - current_active_count)
        if count <= 0:
            _log.info("[FARGATE_ORCHESTRATOR] [CEILING_REACHED] Den '%s' already has %d active runner(s) (Max: %d) — bypassing spawn.", den_id, current_active_count, den_max_runners)
            return []

        _log.info("[FARGATE_ORCHESTRATOR] [START] Initiating launch of %d dynamic runner(s) for Den ID: %s (Current active: %d, Max: %d, Warm: %s)", count, den_id, current_active_count, den_max_runners, is_warm)

        aws_key = den.get("aws_access_key") or ""
        aws_secret = den.get("aws_secret_key") or ""
        aws_region = den.get("aws_region") or "eu-west-1"

        if not aws_key or not aws_secret:
            _log.error("[FARGATE_ORCHESTRATOR] [FAILED] Missing AWS credentials in Den '%s' settings — cannot provision cloud runners.", den_id)
            return []

        # Get active runner key for Fargate runner authentication
        runner_keys = await deps.db_client.get_runner_keys()
        active_keys = [rk["key"] for rk in runner_keys if rk.get("status") == "active"]
        runner_key = active_keys[0] if active_keys else ""

        # Capture is_warm for the threadpool closure
        is_warm_spawn = is_warm

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
            vpcs = ec2.describe_vpcs(Filters=[{"Name": "tag:Name", "Values": ["ferret-vpc-dev"]}])
            vpc_id = vpcs["Vpcs"][0]["VpcId"] if vpcs.get("Vpcs") else None
            if not vpc_id:
                # Fallback to default VPC
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
            subnets = ec2.describe_subnets(Filters=[
                {"Name": "vpc-id", "Values": [vpc_id]},
                {"Name": "tag:Name", "Values": ["ferret-public-subnet-a"]}
            ])
            if not subnets.get("Subnets"):
                subnets = ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc_id]}])
            subnet_ids = [sub["SubnetId"] for sub in subnets.get("Subnets", [])]
            if not subnet_ids:
                _log.error("[FARGATE_ORCHESTRATOR] [SUBNET_DISCOVERY] No subnets found for VPC '%s'", vpc_id)
                raise Exception(f"No subnets found for VPC '{vpc_id}'")
            _log.info("[FARGATE_ORCHESTRATOR] [SUBNET_DISCOVERY] Selected Subnet ID: %s", subnet_ids[0])

            # Check Security Group
            _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Checking if 'ferret-runner-outbound-sg' exists in VPC '%s'...", vpc_id)
            sgs = ec2.describe_security_groups(Filters=[
                {"Name": "group-name", "Values": ["ferret-runner-outbound-sg"]},
                {"Name": "vpc-id", "Values": [vpc_id]}
            ])
            if sgs.get("SecurityGroups"):
                sg_id = sgs["SecurityGroups"][0]["GroupId"]
                _log.info("[FARGATE_ORCHESTRATOR] [SG_SETUP] Found existing outbound SG ID: %s", sg_id)
            else:
                raise Exception("Required Security Group 'ferret-runner-outbound-sg' not found. Please run terraform apply first.")

            # Role configuration
            role_arn = None
            _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Retrieving execution role 'ferretExecutionRole'...")
            try:
                role_res = iam.get_role(RoleName="ferretExecutionRole")
                role_arn = role_res["Role"]["Arn"]
                _log.info("[FARGATE_ORCHESTRATOR] [ROLE_SETUP] Found existing role ARN: %s", role_arn)
            except Exception:
                raise Exception("Required IAM Role 'ferretExecutionRole' not found. Please run terraform apply first.")

            import uuid
            import os
            import base64
            import time
            from pathlib import Path

            # Read and Base64-encode the latest local runner.py — done once for all tasks
            runner_b64 = ""
            try:
                runner_path = Path(__file__).parent.parent.parent / "lab" / "runner.py"
                if not runner_path.exists():
                    runner_path = Path("/app/runner.py")
                if runner_path.exists():
                    _log.info("[FARGATE_ORCHESTRATOR] Encoding local runner.py for injection from: %s", runner_path)
                    runner_b64 = base64.b64encode(runner_path.read_bytes()).decode("utf-8")
            except Exception as b64_err:
                _log.warning("[FARGATE_ORCHESTRATOR] Failed to read/encode local runner.py: %s", b64_err)

            task_image = den.get("runner_image")
            if not task_image:
                env_image = os.environ.get("FERRET_RUNNER_IMAGE")
                # Avoid pulling from GHCR on AWS Fargate by default since Public ECR is far more performant and reliable
                if env_image and "ghcr.io" not in env_image:
                    task_image = env_image
                else:
                    task_image = "public.ecr.aws/t1l1g2t5/ferret-runner:latest"
            kill_flag = "1" if den.get("kill_if_unreachable", 1) else "0"

            # Base task environment — runner-specific vars are injected per-task via containerOverrides
            base_task_env = [
                {"name": "FERRET_API_URL", "value": f"http://{ec2_private_ip}"},
                {"name": "FERRET_KILL_IF_UNREACHABLE", "value": kill_flag},
            ]
            if runner_b64:
                base_task_env.append({"name": "RUNNER_PY_B64", "value": runner_b64})
            if runner_key:
                base_task_env.append({"name": "FERRET_RUNNER_KEY", "value": runner_key})

            _log.info("[FARGATE_ORCHESTRATOR] [TASK_IMAGE] Using runner image: %s", task_image)

            # Register task definition once (no runner-specific env vars — those go in containerOverrides)
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_DEF] Registering Task Definition 'ferret-runner-%s' (Image: %s)...", den_id, task_image)
            task_def_res = ecs.register_task_definition(
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
                        "environment": base_task_env,
                        "entryPoint": ["bash", "-c"] if runner_b64 else ["/entrypoint.sh"],
                        "command": [
                            "echo \"$RUNNER_PY_B64\" | base64 -d > /runner.py && exec /entrypoint.sh"
                        ] if runner_b64 else [],
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
            task_def_arn = task_def_res["taskDefinition"]["taskDefinitionArn"]
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_DEF] Task Definition registered successfully. ARN: %s", task_def_arn)

            # Launch tasks — each gets a unique runner_id and is_warm flag via containerOverrides
            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] Spinning up %d Fargate ECS task(s) on cluster 'ferret-runners'...", count)
            task_arns = []
            for i in range(count):
                r_uuid = uuid.uuid4().hex[:6]
                runner_id = f"runner-fargate-{den_id}-{r_uuid}"
                is_warm = is_warm_spawn
                _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] Spawning task %d/%d runner_id=%s warm=%s", i + 1, count, runner_id, is_warm)

                per_task_overrides = {
                    "containerOverrides": [
                        {
                            "name": "runner",
                            "environment": [
                                {"name": "FERRET_RUNNER_ID", "value": runner_id},
                                {"name": "FERRET_IS_WARM_RUNNER", "value": "1" if is_warm else "0"},
                            ]
                        }
                    ]
                }

                for attempt in range(6):
                    try:
                        task_res = ecs.run_task(
                            cluster="ferret-runners",
                            taskDefinition=task_def_arn,
                            launchType="FARGATE",
                            enableExecuteCommand=True,
                            overrides=per_task_overrides,
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
                            task_arns.append((arn, runner_id))
                            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN_SUCCESS] Spawned Fargate task ARN: %s runner_id: %s", arn, runner_id)
                            break
                        else:
                            _log.error("[FARGATE_ORCHESTRATOR] [TASK_RUN_FAILED] No task info returned: %s", task_res)
                            break
                    except Exception as run_err:
                        if "unable to assume the role" in str(run_err) and attempt < 5:
                            sleep_time = (attempt + 1) * 5
                            _log.info("[FARGATE_ORCHESTRATOR] [TASK_RUN] IAM role still propagating. Retrying in %ds...", sleep_time)
                            time.sleep(sleep_time)
                        else:
                            raise run_err

            return task_arns

        try:
            loop = asyncio.get_event_loop()
            arn_runner_pairs = await loop.run_in_executor(None, _provision_fargate_task)
            # Pre-register each runner as 'provisioning' immediately after ECS confirms the task launch.
            # This is the critical fix for the spawning storm: the DB ceiling check will now see these
            # runners before they finish booting, preventing duplicate spawns.
            arns = []
            for arn, runner_id in arn_runner_pairs:
                arns.append(arn)
                try:
                    await deps.db_client.register_provisioning_runner(runner_id)
                    _log.info("[Orchestrator] Pre-registered provisioning runner '%s' (ARN: %s)", runner_id, arn)
                except Exception as reg_err:
                    _log.warning("[Orchestrator] Failed to pre-register runner '%s': %s", runner_id, reg_err)
            _log.info("[Orchestrator] Successfully spawned %d Fargate task(s): %s", len(arns), arns)
            return arns
        except Exception as e:
            _log.error("[Orchestrator] Fargate spawning failed: %s", e)
            return []

    @staticmethod
    async def stop_runner_task(den_id: str, runner_id: str) -> bool:
        """Finds and terminates the specific Fargate ECS task associated with a runner_id."""
        _log.info("[FARGATE_ORCHESTRATOR] [STOP] Attempting to stop runner task %s", runner_id)
        
        # 1. Fetch targeted Den record
        den = await deps.db_client.get_den(den_id)
        if not den or den["type"] != "aws":
            _log.info("[Orchestrator] Den ID '%s' is not an AWS Den — bypassing cloud Fargate stop.", den_id)
            await deps.db_client.update_runner_status(runner_id, "offline")
            return True

        aws_key = den.get("aws_access_key") or ""
        aws_secret = den.get("aws_secret_key") or ""
        aws_region = den.get("aws_region") or "eu-west-1"

        if not aws_key or not aws_secret:
            _log.error("[FARGATE_ORCHESTRATOR] [FAILED] Missing AWS credentials in Den '%s' settings — cannot stop cloud runner.", den_id)
            await deps.db_client.update_runner_status(runner_id, "offline")
            return False

        try:
            import boto3
            from botocore.config import Config
        except ImportError:
            _log.warning("[Orchestrator] 'boto3' not installed in this environment — simulating successful AWS Fargate task stop.")
            await deps.db_client.update_runner_status(runner_id, "offline")
            return True

        def _stop_fargate_task():
            config = Config(region_name=aws_region)
            ecs = boto3.client("ecs", aws_access_key_id=aws_key, aws_secret_access_key=aws_secret, config=config)

            resp = ecs.list_tasks(cluster="ferret-runners")
            task_arns = resp.get("taskArns", [])
            if not task_arns:
                _log.warning("[FARGATE_ORCHESTRATOR] [STOP] No active tasks found on cluster 'ferret-runners'")
                return False

            task_arn = None
            for i in range(0, len(task_arns), 100):
                chunk = task_arns[i:i+100]
                tasks_resp = ecs.describe_tasks(cluster="ferret-runners", tasks=chunk)
                for task in tasks_resp.get("tasks", []):
                    container_overrides = task.get("overrides", {}).get("containerOverrides", [])
                    for co in container_overrides:
                        env = co.get("environment", [])
                        for env_var in env:
                            if env_var.get("name") == "FERRET_RUNNER_ID" and env_var.get("value") == runner_id:
                                task_arn = task.get("taskArn")
                                break
                        if task_arn:
                            break
                    if task_arn:
                        break
                if task_arn:
                    break

            if not task_arn:
                _log.warning("[FARGATE_ORCHESTRATOR] [STOP] No active Fargate task found for runner %s", runner_id)
                return False

            task_id = task_arn.split("/")[-1]
            _log.info("[FARGATE_ORCHESTRATOR] [STOP] Found task %s. Stopping task...", task_id)
            ecs.stop_task(cluster="ferret-runners", task=task_id, reason="Reaped excess warm runner")
            return True

        try:
            loop = asyncio.get_event_loop()
            success = await loop.run_in_executor(None, _stop_fargate_task)
            await deps.db_client.update_runner_status(runner_id, "offline")
            return success
        except Exception as e:
            _log.error("[Orchestrator] Fargate stop failed for runner %s: %s", runner_id, e)
            await deps.db_client.update_runner_status(runner_id, "offline")
            return False
