import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).parent / "src/apps/api"))

import deps

ws_spec = {
    "name": "test.tesla.com",
    "files": {},
    "runs": [{"plan_id": "builtin:whatweb", "target_url": "https://test.tesla.com"}]
}

async def run():
    print("1: Connecting to DB...")
    await deps.db_client.connect()
    print("2: Reloading AI config...")
    await deps.reload_ai_config()
    print("3: Processing manifest entry...")
    try:
        await deps.script_execution_engine._process_manifest_entry(
            ws_spec, 
            parent_workspace_id="f16dfdee-08ef-43b2-91bd-76103f3df6ca", 
            project_id="temp"
        )
        print("4: Manifest entry processed successfully!")
    except Exception as e:
        print("ERROR:", e)
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    asyncio.run(run())
