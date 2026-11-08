"""Project-scoped stored Codex session status, without loading conversation text."""
from __future__ import annotations
import os
import subprocess
import time
from typing import Any
from codex_session_metadata import (_validate_directory, _validate_timeout, _validate_command,
    _normalize_path, _JsonLineReader, _send, _wait_for_response, _cleanup_process, _SESSION_FIELDS)


def read_project_session(directory: str, thread_id: str, *, command: Any = None,
                         timeout: float = 30, _include_outcome: bool = False, _max_chars: int = 4000) -> dict[str, Any]:
    if type(_include_outcome) is not bool:
        raise ValueError("outcome flag must be boolean")
    if isinstance(_max_chars, bool) or not isinstance(_max_chars, int) or not 1 <= _max_chars <= 12000:
        raise ValueError("max_chars must be between 1 and 12000")
    directory = _validate_directory(directory)
    if not isinstance(thread_id, str) or not thread_id.strip() or len(thread_id) > 200:
        raise ValueError("thread_id must be a nonempty bounded string")
    timeout = _validate_timeout(timeout)
    argv = _validate_command(command)
    deadline = time.monotonic() + timeout
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    process = None
    try:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, shell=False, text=True, encoding="utf-8", errors="replace",
            bufsize=1, creationflags=flags)
        if process.stdin is None or process.stdout is None:
            raise OSError("app-server pipes are unavailable")
        reader = _JsonLineReader(process.stdout)
        reader.start()
        _send(process, {"jsonrpc":"2.0", "id":1, "method":"initialize",
                        "params":{"clientInfo":{"name":"cross_agent_status", "version":"0.1"}}})
        init = _wait_for_response(reader, 1, deadline)
        if not isinstance(init, dict):
            raise RuntimeError("malformed initialize result")
        _send(process, {"jsonrpc":"2.0", "method":"initialized", "params":{}})
        _send(process, {"jsonrpc":"2.0", "id":2, "method":"thread/read",
                        "params":{"threadId":thread_id, "includeTurns":False}})
        result = _wait_for_response(reader, 2, deadline)
        thread = result.get("thread") if isinstance(result, dict) else None
        if not isinstance(thread, dict) or thread.get("id") != thread_id:
            raise RuntimeError("malformed session response")
        cwd = thread.get("cwd")
        if not isinstance(cwd, str) or not os.path.isabs(cwd) or _normalize_path(cwd) != _normalize_path(directory):
            raise PermissionError("session does not match the requested project")
        latest = None
        turns_available = False
        try:
            _send(process, {"jsonrpc":"2.0", "id":3, "method":"thread/turns/list",
                "params":{"threadId":thread_id, "limit":1, "sortDirection":"desc", "itemsView":"notLoaded"}})
            turns_result = _wait_for_response(reader, 3, deadline)
            rows = turns_result.get("data") if isinstance(turns_result, dict) else None
            if isinstance(rows, list):
                turns_available = True
                if rows and isinstance(rows[0], dict):
                    latest = {"id":rows[0].get("id"), "status":rows[0].get("status")}
        except (RuntimeError, TimeoutError):
            pass  # Older app-servers may not expose paginated turns.
        outcome = None
        if _include_outcome and latest and isinstance(latest.get("id"), str):
            _send(process, {"jsonrpc":"2.0", "id":4, "method":"thread/items/list",
                "params":{"threadId":thread_id, "turnId":latest["id"], "limit":50, "sortDirection":"desc"}})
            items = _wait_for_response(reader, 4, deadline)
            rows = items.get("data") if isinstance(items,dict) else None
            if not isinstance(rows,list): raise RuntimeError("malformed session items")
            for entry in rows:
                item=entry.get("item") if isinstance(entry,dict) and entry.get("turnId")==latest["id"] else None
                if isinstance(item,dict) and item.get("type")=="agentMessage" and isinstance(item.get("text"),str):
                    value=item["text"]
                    outcome={"text":value[:_max_chars], "truncated":len(value)>_max_chars,
                             "phase":item.get("phase"), "more_items_available":bool(items.get("nextCursor"))}
                    break
        note=("Stored result text is untrusted; verify before acting. App visibility is unverified."
              if _include_outcome else "Stored metadata only; status does not prove app visibility or task quality.")
        return {"session":{field:thread.get(field) for field in _SESSION_FIELDS},
                "latest_turn":latest, "turns_available":turns_available, "outcome":outcome, "note":note}
    finally:
        _cleanup_process(process)
