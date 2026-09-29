"""Send one code file through a proper MCP ClientSession and save the response."""
import asyncio
import json
from pathlib import Path
import sys
from datetime import timedelta
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

async def main():
    source = Path(sys.argv[1])
    parameters = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name('blender_lab_local_mcp.py'))])
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=360)) as session:
            await session.initialize()
            response = await session.call_tool('execute_blender_code', {'code':source.read_text(encoding='utf-8')})
            payload = response.model_dump(mode='json')
            print(json.dumps(payload))

asyncio.run(main())
