"""Project-scoped, read-only Codex goal status; never resumes a session."""
from __future__ import annotations
import math, os, subprocess, time
from typing import Any
from codex_session_metadata import (_JsonLineReader, _cleanup_process, _normalize_path, _send,
    _validate_command, _validate_directory, _validate_timeout, _wait_for_response)

STATES = frozenset(('active', 'paused', 'blocked', 'complete', 'budgetLimited',
                    'budget_limited', 'usageLimited', 'usage_limited'))

def _nonnegative(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return None
    return value

def read_project_goal(directory: str, thread_id: str, *, command: Any = None, timeout: float = 30) -> dict[str, Any]:
    """Read lifecycle and usage only after verifying the project directory."""
    directory = _validate_directory(directory)
    if not isinstance(thread_id, str) or not thread_id.strip() or len(thread_id) > 200:
        raise ValueError('thread_id must be a nonempty bounded string')
    argv = _validate_command(command)
    deadline = time.monotonic() + _validate_timeout(timeout)
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    process = None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False, text=True, encoding='utf-8',
            errors='replace', bufsize=1, creationflags=flags)
        if process.stdin is None or process.stdout is None:
            raise OSError('app-server pipes are unavailable')
        reader = _JsonLineReader(process.stdout)
        reader.start()
        _send(process, {'jsonrpc':'2.0', 'id':1, 'method':'initialize',
                        'params':{'clientInfo':{'name':'cross_agent_goal_status', 'version':'0.1'}}})
        if not isinstance(_wait_for_response(reader, 1, deadline), dict):
            raise RuntimeError('malformed initialize result')
        _send(process, {'jsonrpc':'2.0', 'method':'initialized', 'params':{}})
        _send(process, {'jsonrpc':'2.0', 'id':2, 'method':'thread/read',
                        'params':{'threadId':thread_id, 'includeTurns':False}})
        result = _wait_for_response(reader, 2, deadline)
        thread = result.get('thread') if isinstance(result, dict) else None
        if not isinstance(thread, dict) or thread.get('id') != thread_id:
            raise RuntimeError('malformed session response')
        cwd = thread.get('cwd')
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or _normalize_path(cwd) != _normalize_path(directory):
            raise PermissionError('session does not match the requested project')
        _send(process, {'jsonrpc':'2.0', 'id':3, 'method':'thread/goal/get', 'params':{'threadId':thread_id}})
        result = _wait_for_response(reader, 3, deadline)
        if not isinstance(result, dict) or 'goal' not in result:
            raise RuntimeError('malformed goal response')
        goal = result['goal']
        if goal is None:
            return {'goal':None, 'note':'No persisted goal reported; no action was taken.'}
        if not isinstance(goal, dict) or goal.get('threadId') != thread_id:
            raise RuntimeError('malformed or mismatched goal response')
        status = goal.get('status')
        return {'goal':{'status':status if isinstance(status, str) and status in STATES else 'unknown',
                        'tokenBudget':_nonnegative(goal.get('tokenBudget')),
                        'tokensUsed':_nonnegative(goal.get('tokensUsed')),
                        'timeUsedSeconds':_nonnegative(goal.get('timeUsedSeconds'))},
                'note':'Read-only; an active goal does not prove a chat will wake after a rate limit or another app process is idle.'}
    finally:
        _cleanup_process(process)
