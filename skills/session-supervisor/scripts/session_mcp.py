"""One stdio MCP surface for project-scoped Codex and Claude Code sessions.

No credentials or transcripts are stored by this server. The native Codex app
controls take precedence for operations they expose. Wake scheduling is not
advertised as operational without a host-owned atomic conditional dispatcher.
"""
from __future__ import annotations
import asyncio
import shutil
from typing import Any
from mcp.server.mcpserver import MCPServer
import claude_adapter
from codex_adapter import CodexAdapter

server = MCPServer('session-supervisor')


@server.tool()
async def session_capabilities() -> dict[str, Any]:
    """Discover installed clients without inference or credential disclosure."""
    return {
        'codex_cli_found': bool(shutil.which('codex')),
        'claude_cli_found': bool(shutil.which('claude')),
        'codex_native_app_tools': 'Discover in the current host; not exposed to this process.',
        'claude_history': 'Agent SDK optional; CLI alone has incomplete history.',
        'codex_automatic_wakeup': False,
        'note': 'Client availability does not prove authentication, pricing or provider access.',
    }


@server.tool()
async def session_list(provider: str, project: str, limit: int = 20) -> dict[str, Any]:
    """List session metadata in one project, not conversation transcripts."""
    if provider == 'codex':
        return await asyncio.to_thread(CodexAdapter(project).list_sessions, limit)
    if provider == 'claude':
        return await asyncio.to_thread(claude_adapter.list_sessions, project, limit=limit)
    raise ValueError('provider must be codex or claude')


@server.tool()
async def session_status(provider: str, project: str, session_id: str) -> dict[str, Any]:
    """Read a project-matched session status; snapshots may be stale."""
    if provider == 'codex':
        return await asyncio.to_thread(CodexAdapter(project).session_status, session_id)
    if provider == 'claude':
        return await asyncio.to_thread(claude_adapter.session_status, project, session_id)
    raise ValueError('provider must be codex or claude')


@server.tool()
async def codex_session_outcome(project: str, session_id: str, authorized: bool = False,
                                max_chars: int = 2000) -> dict[str, Any]:
    """Read a bounded outcome only when the human authorized this exact session."""
    if authorized is not True:
        raise PermissionError('specific session authorization required')
    return await asyncio.to_thread(CodexAdapter(project).session_outcome, session_id,
                                   authorized=True, max_chars=max_chars)


@server.tool()
async def codex_goal_status(project: str, session_id: str) -> dict[str, Any]:
    """Read goal lifecycle and usage for a project-matched Codex session."""
    return await asyncio.to_thread(CodexAdapter(project).goal_status, session_id)


@server.tool()
async def codex_rate_limits() -> dict[str, Any]:
    """Read Codex account limit windows without inference or consuming resets."""
    from codex_account_limits import read_limits
    return await asyncio.to_thread(read_limits)


@server.tool()
async def codex_wakeup_capability() -> dict[str, Any]:
    """Report whether this package can actually wake a rate-limited desktop chat."""
    return {'automatic_wakeup_available': False, 'queued': False,
            'reason': 'The current adapter lacks host-owned atomic idle-only dispatch and deduplication.',
            'note': 'Do not send a prompt to an active or uncertain session. Native app tools may have other capabilities.'}


@server.tool()
async def claude_probe() -> dict[str, Any]:
    """Probe Claude Code version and sign-in state without a model request."""
    return await asyncio.to_thread(claude_adapter.probe)


@server.tool()
async def claude_start(project: str, prompt: str, authorized: bool = False,
                       model_use_authorized: bool = False, include_outcome: bool = False,
                       max_outcome_chars: int = 2000) -> dict[str, Any]:
    """Start a new Claude session only on explicit user request for this project and model use."""
    if authorized is not True or model_use_authorized is not True:
        raise PermissionError('specific new session and model use must be authorized')
    return await asyncio.to_thread(claude_adapter.start_session, project, prompt,
        authorized=True, model_use_authorized=True, include_outcome=include_outcome,
        max_outcome_chars=max_outcome_chars)


@server.tool()
async def claude_resume(project: str, session_id: str, prompt: str, authorized: bool = False,
                        model_use_authorized: bool = False, include_outcome: bool = False,
                        max_outcome_chars: int = 2000) -> dict[str, Any]:
    """Resume only the user-authorized Claude session under its authorized model budget."""
    if authorized is not True or model_use_authorized is not True:
        raise PermissionError('specific session and model use must be authorized')
    return await asyncio.to_thread(claude_adapter.resume_session, project, session_id, prompt,
        authorized=True, model_use_authorized=True, include_outcome=include_outcome,
        max_outcome_chars=max_outcome_chars)


@server.tool()
async def claude_stop(project: str, session_id: str, authorized: bool = False) -> dict[str, Any]:
    """Request stop only for the explicitly authorized Claude background session."""
    if authorized is not True:
        raise PermissionError('specific session authorization required')
    return await asyncio.to_thread(claude_adapter.stop_session, project, session_id, authorized=True)


@server.tool()
async def claude_session_summary(project: str, session_id: str, authorized: bool = False,
                                 max_chars: int = 2000) -> dict[str, Any]:
    """Read a bounded summary only for the explicitly authorized Claude session; requires Agent SDK."""
    if authorized is not True:
        raise PermissionError('specific session authorization required')
    return await asyncio.to_thread(claude_adapter.read_session_summary, project, session_id,
                                   authorized=True, max_chars=max_chars)


@server.tool()
async def claude_rename(project: str, session_id: str, title: str, authorized: bool = False) -> dict[str, Any]:
    """Rename only the specifically authorized, project-matched Claude session; requires Agent SDK."""
    if authorized is not True:
        raise PermissionError('specific session authorization required')
    return await asyncio.to_thread(claude_adapter.rename_session, project, session_id, title, authorized=True)


@server.tool()
async def claude_tag(project: str, session_id: str, tag: str | None, authorized: bool = False) -> dict[str, Any]:
    """Set or clear a tag only for the specifically authorized Claude session; requires Agent SDK."""
    if authorized is not True:
        raise PermissionError('specific session authorization required')
    return await asyncio.to_thread(claude_adapter.tag_session, project, session_id, tag, authorized=True)


if __name__ == '__main__':
    server.run()
