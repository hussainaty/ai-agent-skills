"""Local MCP transport adapter for the installed official Blender Lab add-on.

The configured v1.0.0 uvx Git download is blocked by the upstream host.
This adapter uses the installed add-on's documented null-terminated JSON
transport, preserving its execution restrictions and deferred responses.
"""
import json
import socket
from mcp.server.fastmcp import FastMCP

mcp = FastMCP('blender_lab_local_transport')

@mcp.tool()
def execute_blender_code(code: str) -> dict:
    """Execute Python through the installed Blender Lab MCP add-on."""
    with socket.create_connection(('127.0.0.1', 9876), timeout=15) as connection:
        connection.settimeout(300)
        connection.sendall((json.dumps({'type':'execute','code':code,'strict_json':True})+'\0').encode())
        response = bytearray()
        while True:
            part = connection.recv(65536)
            if not part:
                raise RuntimeError('Blender MCP connection closed before a complete response')
            response.extend(part)
            if b'\0' in response:
                return json.loads(response.split(b'\0',1)[0])

if __name__ == '__main__':
    mcp.run(transport='stdio')
