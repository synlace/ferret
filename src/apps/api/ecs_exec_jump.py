#!/usr/bin/env python3
import os
import sys
import asyncio
import logging
from pathlib import Path

# Configure simple logging
logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger("ecs-jump")

# Ensure we can import modules from the local directory
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from sqlite_client import SQLiteClient

async def get_den_config(runner_id: str, is_silent: bool = False):
    den_id = "aws"
    if runner_id.startswith("runner-fargate-"):
        parts = runner_id.split("-")
        if len(parts) >= 4:
            den_id = parts[2]
            
    db = SQLiteClient(db_path=Path("/data/ferret.db"))
    try:
        if is_silent:
            import contextlib
            with open(os.devnull, 'w') as f, contextlib.redirect_stdout(f):
                await db.initialize()
        else:
            await db.initialize()
        den = await db.get_den(den_id)
        return den
    except Exception as e:
        logger.error(f"Error fetching Den config from database: {e}")
        return None
    finally:
        try:
            await db.close()
        except Exception:
            pass

async def main():
    args_list = sys.argv[1:]
    if not args_list:
        logger.error("Usage: ecs_exec_jump.py <runner_id> [command] [--verbose|-v]")
        sys.exit(1)

    verbose = False
    if "--verbose" in args_list:
        verbose = True
        args_list.remove("--verbose")
    if "-v" in args_list:
        verbose = True
        args_list.remove("-v")

    runner_id = args_list[0]
    # We are silent on success by default unless verbose is enabled
    is_silent = not verbose
    is_interactive = len(args_list) == 1
    command = args_list[1] if len(args_list) > 1 else "/bin/bash"

    if not is_silent:
        logger.info(f"Looking up Den credentials for runner: {runner_id}...")
    den = await get_den_config(runner_id, is_silent=is_silent)
    if not den:
        logger.error(f"Error: Could not find Den configuration in the database.")
        sys.exit(1)

    aws_key = den.get("aws_access_key")
    aws_secret = den.get("aws_secret_key")
    aws_region = den.get("aws_region") or "eu-west-1"

    if not aws_key or not aws_secret:
        logger.error(f"Error: Den AWS access key or secret key is empty in the database.")
        sys.exit(1)

    # Import boto3 dynamically after setting up path
    try:
        import boto3
        from botocore.config import Config
    except ImportError:
        logger.error("Error: boto3 is not installed in the API container environment.")
        sys.exit(1)

    if not is_silent:
        logger.info("Initializing AWS Fargate clients...")
    config = Config(region_name=aws_region)
    try:
        session = boto3.Session(
            aws_access_key_id=aws_key,
            aws_secret_access_key=aws_secret,
            region_name=aws_region
        )
        ecs = session.client("ecs", config=config)
    except Exception as e:
        logger.error(f"Error creating boto3 ECS client: {e}")
        sys.exit(1)

    if not is_silent:
        logger.info("Listing active ECS tasks...")
    try:
        resp = ecs.list_tasks(cluster="ferret-runners")
        task_arns = resp.get("taskArns", [])
    except Exception as e:
        logger.error(f"Error listing ECS tasks: {e}")
        sys.exit(1)

    if not task_arns:
        logger.error("Error: No active Fargate tasks found on cluster 'ferret-runners'.")
        sys.exit(1)

    if not is_silent:
        logger.info(f"Describing {len(task_arns)} active tasks to locate runner ID {runner_id}...")
    try:
        # Describe tasks in chunks of 100 (boto3 describe_tasks limit is 100)
        task_arn = None
        for i in range(0, len(task_arns), 100):
            chunk = task_arns[i:i+100]
            tasks_resp = ecs.describe_tasks(cluster="ferret-runners", tasks=chunk)
            for task in tasks_resp.get("tasks", []):
                overrides = task.get("overrides", {})
                container_overrides = overrides.get("containerOverrides", [])
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
    except Exception as e:
        logger.error(f"Error describing tasks: {e}")
        sys.exit(1)

    if not task_arn:
        logger.error(f"Error: Could not find active Fargate runner task with ID: {runner_id}")
        sys.exit(1)

    task_id = task_arn.split("/")[-1]
    if not is_silent:
        logger.info(f"Task found! Task ID: {task_id}")
        logger.info("Spawning interactive AWS Systems Manager (SSM) shell connection...")

    # Set AWS environment variables for the exec session
    env = os.environ.copy()
    env["AWS_ACCESS_KEY_ID"] = aws_key
    env["AWS_SECRET_ACCESS_KEY"] = aws_secret
    env["AWS_DEFAULT_REGION"] = aws_region

    args = [
        "aws", "ecs", "execute-command",
        "--region", aws_region,
        "--cluster", "ferret-runners",
        "--task", task_id,
        "--container", "runner",
        "--command", command,
        "--interactive"
    ]

    if is_silent and not is_interactive:
        import subprocess
        try:
            p = subprocess.Popen(
                args,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            stdout, stderr = p.communicate()
            
            def filter_ssm_noise(text: str) -> str:
                if not text:
                    return ""
                lines = []
                for line in text.splitlines():
                    lower_line = line.lower()
                    if "session manager plugin" in lower_line:
                        continue
                    if "use the aws cli to start a session" in lower_line:
                        continue
                    if "starting session with sessionid" in lower_line:
                        continue
                    if "exiting session with sessionid" in lower_line:
                        continue
                    lines.append(line)
                return "\n".join(lines) + ("\n" if lines else "")
                
            filtered_stdout = filter_ssm_noise(stdout)
            filtered_stderr = filter_ssm_noise(stderr)
            
            # Since non-interactive, also strip trailing newlines or extra blank lines at the start/end
            filtered_stdout = filtered_stdout.strip() + ("\n" if filtered_stdout.strip() else "")
            filtered_stderr = filtered_stderr.strip() + ("\n" if filtered_stderr.strip() else "")
                
            if filtered_stdout:
                sys.stdout.write(filtered_stdout)
            if filtered_stderr:
                sys.stderr.write(filtered_stderr)
            sys.exit(p.returncode)
        except Exception as e:
            logger.error(f"Failed to execute command via subprocess: {e}")
            sys.exit(1)

    if is_silent and is_interactive:
        import pty
        # Set environment variables in the parent process so the child spawned by pty inherits them
        os.environ["AWS_ACCESS_KEY_ID"] = aws_key
        os.environ["AWS_SECRET_ACCESS_KEY"] = aws_secret
        os.environ["AWS_DEFAULT_REGION"] = aws_region
        
        state = {
            "prompt_seen": False,
            "buffer": b""
        }
        
        def custom_read(fd):
            data = os.read(fd, 2048)
            if not data:
                return b""
                
            if state["prompt_seen"]:
                # Simply filter out the SSM exit message on close
                if b"exiting session" in data.lower():
                    return b""
                return data
                
            state["buffer"] += data
            
            # Check if the connection setup is complete
            if b"starting session with sessionid" in state["buffer"].lower():
                idx = state["buffer"].lower().find(b"starting session with sessionid")
                # Find the newline after the "starting session" line
                nl_idx = state["buffer"].find(b"\n", idx)
                if nl_idx != -1:
                    # Setup is done. Extract everything after the setup boilerplate
                    remaining_data = state["buffer"][nl_idx + 1:]
                    state["prompt_seen"] = True
                    state["buffer"] = b""
                    return remaining_data if remaining_data else b"\r"
                return b"\r"
            else:
                return b"\r"

        try:
            argv = ["aws"] + args[1:]
            pty.spawn(argv, custom_read)
            sys.exit(0)
        except Exception as e:
            logger.error(f"Failed to spawn interactive pty session: {e}")
            sys.exit(1)

    try:
        os.execvpe("aws", args, env)
    except Exception as e:
        logger.error(f"Failed to execute 'aws' process: {e}")
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
