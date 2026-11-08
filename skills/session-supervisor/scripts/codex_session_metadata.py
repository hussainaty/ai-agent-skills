"""Project session metadata and empty session creation via the Codex app-server.

The public function :func:`list_project_sessions` speaks the app-server
JSON-lines protocol over a child process and returns sanitized metadata only.
It never returns previews, transcripts, or message content.
"""

from __future__ import annotations

import asyncio
import codecs
import select
import json
import math
import os
import queue
import subprocess
import threading
import time
from typing import Any

DEFAULT_COMMAND = ("codex", "app-server")
NOTE = "metadata only; visibility and access must be verified"
_SESSION_FIELDS = ("id", "name", "cwd", "status", "updatedAt")


def _validate_directory(directory: Any) -> str:
    try:
        raw = os.fspath(directory)
    except TypeError as exc:
        raise TypeError("directory must be a path-like value") from exc

    if isinstance(raw, bytes):
        raw = os.fsdecode(raw)
    if not isinstance(raw, str) or not raw:
        raise ValueError("directory must be a non-empty absolute path")
    if not os.path.isabs(raw):
        raise ValueError("directory must be an absolute path")
    if not os.path.isdir(raw):
        raise ValueError("directory must be an existing directory")
    return raw


def _validate_limit(limit: Any) -> int:
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise TypeError("limit must be an integer")
    if not 1 <= limit <= 50:
        raise ValueError("limit must be between 1 and 50")
    return limit


def _validate_timeout(timeout: Any) -> float:
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
        raise TypeError("timeout must be a positive finite number")
    value = float(timeout)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("timeout must be a positive finite number")
    return value


def _validate_command(command: Any) -> list[str]:
    if command is None:
        return list(DEFAULT_COMMAND)
    if isinstance(command, (str, bytes)):
        raise TypeError("command must be a sequence of strings")
    try:
        parts = list(command)
    except TypeError as exc:
        raise TypeError("command must be a sequence of strings") from exc
    if not parts or not all(isinstance(part, str) and part for part in parts):
        raise ValueError("command must be a non-empty sequence of strings")
    return parts


def _normalize_path(path: str) -> str:
    # normcase makes directory comparisons case-insensitive on Windows.
    return os.path.normcase(os.path.normpath(path))


class _JsonLineReader:
    """Read bounded JSON lines without blocking cleanup on inherited pipes."""

    def __init__(self, stream: Any) -> None:
        self._stream = stream
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._stopped = threading.Event()
        self._thread = threading.Thread(target=self._run, name="codex-app-server-reader", daemon=True)
        setattr(stream, "_codex_json_reader", self)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stopped.set()
        self._thread.join(timeout=1)

    def _readable_windows(self, fd: int) -> int | None:
        import ctypes
        import msvcrt
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        peek = kernel.PeekNamedPipe
        peek.argtypes = (wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                         ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD))
        peek.restype = wintypes.BOOL
        available = wintypes.DWORD()
        if not peek(wintypes.HANDLE(msvcrt.get_osfhandle(fd)), None, 0, None, ctypes.byref(available), None):
            error = ctypes.get_last_error()
            if error in (109, 232):  # broken pipe / no data from the closed writer
                return None
            raise OSError(error, "app-server pipe inspection failed")
        return available.value

    def _run(self) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        pending = ""
        try:
            fd = self._stream.fileno()
            while not self._stopped.is_set():
                if os.name == "nt":
                    available = self._readable_windows(fd)
                    if available is None:
                        break
                    if not available:
                        self._stopped.wait(0.05)
                        continue
                    chunk = os.read(fd, min(available, 65536))
                else:
                    ready, _, _ = select.select([fd], [], [], 0.05)
                    if not ready:
                        continue
                    chunk = os.read(fd, 65536)
                if not chunk:
                    break
                pending += decoder.decode(chunk)
                if len(pending) > 16 * 1024 * 1024:
                    raise RuntimeError("app-server emitted an oversized line")
                while "\n" in pending:
                    line, pending = pending.split("\n", 1)
                    if not line.strip():
                        continue
                    try:
                        self._queue.put(("message", json.loads(line)))
                    except (TypeError, ValueError):
                        raise RuntimeError("app-server emitted malformed JSON") from None
            if not self._stopped.is_set() and pending.strip():
                pending += decoder.decode(b"", final=True)
                try:
                    self._queue.put(("message", json.loads(pending)))
                except (TypeError, ValueError):
                    raise RuntimeError("app-server emitted malformed JSON") from None
            self._queue.put(("closed", None))
        except Exception as exc:
            self._queue.put(("error", exc))
        finally:
            try:
                self._stream.close()
            except Exception:
                pass

    def get(self, deadline: float) -> Any:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out waiting for app-server")
        try:
            kind, payload = self._queue.get(timeout=remaining)
        except queue.Empty:
            raise TimeoutError("timed out waiting for app-server") from None
        if kind == "error":
            if isinstance(payload, OSError):
                raise payload
            raise RuntimeError("failed to read app-server output") from payload
        if kind == "closed":
            raise RuntimeError("app-server closed before sending a response")
        return payload


def _send(process: subprocess.Popen, message: dict[str, Any]) -> None:
    try:
        if process.stdin is None:
            raise OSError("app-server stdin is unavailable")
        process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        process.stdin.flush()
    except OSError as exc:
        raise RuntimeError("failed to write to app-server") from exc


def _wait_for_response(reader: _JsonLineReader, request_id: int, deadline: float) -> Any:
    while True:
        message = reader.get(deadline)
        if not isinstance(message, dict):
            raise RuntimeError("app-server sent a malformed message")
        if "id" not in message:
            # A notification. Unrelated notifications are ignored.
            continue
        if message.get("id") != request_id:
            continue
        if "error" in message:
            raise RuntimeError("app-server returned an error response")
        if "result" not in message:
            raise RuntimeError("app-server response is missing result")
        return message["result"]


def _sanitize_result(result: dict[str, Any], directory: str) -> dict[str, Any]:
    rows = result.get("data")
    if rows is None:
        rows = result.get("threads")
    if not isinstance(rows, list):
        raise RuntimeError("app-server returned malformed session data")

    wanted = _normalize_path(directory)
    sessions: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cwd = row.get("cwd")
        if (
            not isinstance(cwd, str)
            or not os.path.isabs(cwd)
            or _normalize_path(cwd) != wanted
        ):
            continue
        sessions.append({field: row.get(field) for field in _SESSION_FIELDS})

    next_cursor = result.get("nextCursor")
    if "nextCursor" not in result:
        next_cursor = result.get("next_cursor")
    return {"sessions": sessions, "next_cursor": next_cursor, "note": NOTE}


def _sanitize_created_session(result: Any, directory: str) -> dict[str, Any]:
    """Preserve a reported ID even when project association cannot be verified."""
    if not isinstance(result, dict):
        raise RuntimeError("Session creation outcome unknown; inspect before retry")
    thread = result.get("thread")
    data = thread if isinstance(thread, dict) else result
    thread_id = data.get("id") or data.get("threadId")
    if not isinstance(thread_id, str) or not thread_id:
        raise RuntimeError("Session creation outcome unknown; inspect before retry")
    reported_cwd = data.get("cwd")
    session = {field: data.get(field) for field in _SESSION_FIELDS}
    session["id"] = thread_id
    session["ephemeral"] = data.get("ephemeral") if isinstance(data.get("ephemeral"), bool) else None
    matches = (isinstance(reported_cwd, str) and os.path.isabs(reported_cwd)
               and _normalize_path(reported_cwd) == _normalize_path(directory))
    note = ("App visibility and project association unverified; no model turn started."
            if matches else
            "App visibility and project association unverified; reported directory "
            "is missing or different. Inspect this session ID before retry.")
    return {"session": session, "note": note}


def _cleanup_process(process: subprocess.Popen | None) -> None:
    if process is None:
        return

    try:
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()
    except Exception:
        pass

    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        try:
            process.terminate()
        except Exception:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except Exception:
                pass
            try:
                process.wait(timeout=1)
            except Exception:
                pass
        except Exception:
            pass
    except Exception:
        pass

    try:
        if process.stdout is not None:
            reader = getattr(process.stdout, "_codex_json_reader", None)
            if reader is not None:
                reader.stop()
            elif not process.stdout.closed:
                process.stdout.close()
    except Exception:
        pass


def list_project_sessions(
    directory: str,
    limit: int = 10,
    command: Any = None,
    timeout: float = 30,
) -> dict[str, Any]:
    """Return sanitized metadata for sessions whose cwd matches *directory*.

    ``command`` exists only for test injection and defaults to
    ``["codex", "app-server"]``.
    """

    directory = _validate_directory(directory)
    limit = _validate_limit(limit)
    timeout = _validate_timeout(timeout)
    argv = _validate_command(command)
    deadline = time.monotonic() + timeout

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    process: subprocess.Popen | None = None
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            shell=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("app-server pipes are unavailable")

        reader = _JsonLineReader(process.stdout)
        reader.start()

        _send(
            process,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "cross_agent_metadata",
                        "version": "0.1",
                    }
                },
            },
        )
        initialize_result = _wait_for_response(reader, 1, deadline)
        if not isinstance(initialize_result, dict):
            raise RuntimeError("app-server returned a malformed initialize result")

        _send(
            process,
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
        )
        _send(
            process,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "thread/list",
                "params": {
                    "cwd": directory,
                    "limit": limit,
                    "useStateDbOnly": True,
                    "sourceKinds": [
                        "cli",
                        "vscode",
                        "exec",
                        "appServer",
                        "subAgent",
                        "subAgentReview",
                        "subAgentCompact",
                        "subAgentThreadSpawn",
                        "subAgentOther",
                        "unknown",
                    ],
                },
            },
        )
        session_result = _wait_for_response(reader, 2, deadline)
        if not isinstance(session_result, dict):
            raise RuntimeError("app-server returned a malformed thread/list result")
        return _sanitize_result(session_result, directory)
    finally:
        _cleanup_process(process)


def create_project_session(
    directory: str,
    command: Any = None,
    timeout: float = 30,
    *, _ephemeral: bool = False,
) -> dict[str, Any]:
    """Create a Codex thread in *directory* without starting a model turn.

    ``command`` exists only for test injection and defaults to
    ``["codex", "app-server"]``.
    """

    if type(_ephemeral) is not bool:
        raise TypeError("_ephemeral must be a boolean")
    directory = _validate_directory(directory)
    timeout = _validate_timeout(timeout)
    argv = _validate_command(command)
    deadline = time.monotonic() + timeout

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)

    process: subprocess.Popen | None = None
    try:
        process = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            shell=False,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=creationflags,
        )
        if process.stdin is None or process.stdout is None:
            raise OSError("app-server pipes are unavailable")

        reader = _JsonLineReader(process.stdout)
        reader.start()

        _send(
            process,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "cross_agent_metadata",
                        "version": "0.1",
                    }
                },
            },
        )
        initialize_result = _wait_for_response(reader, 1, deadline)
        if not isinstance(initialize_result, dict):
            raise RuntimeError("app-server returned a malformed initialize result")

        _send(
            process,
            {"jsonrpc": "2.0", "method": "initialized", "params": {}},
        )
        try:
            _send(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "thread/start",
                    "params": {"cwd": directory, "ephemeral": _ephemeral},
                },
            )
            session_result = _wait_for_response(reader, 2, deadline)
        except (TimeoutError, RuntimeError, OSError) as exc:
            raise RuntimeError("Session creation outcome unknown; inspect before retry") from exc
        return _sanitize_created_session(session_result, directory)
    finally:
        _cleanup_process(process)


from mcp.server.mcpserver import MCPServer

mcp = MCPServer("codex-project-sessions")


@mcp.tool()
async def codex_project_sessions(directory: str, limit: int = 10) -> dict[str, Any]:
    """List read-only session metadata for an absolute project directory."""

    return await asyncio.to_thread(list_project_sessions, directory, limit)


@mcp.tool()
async def codex_create_project_session(directory: str) -> dict[str, Any]:
    """Create only after the human explicitly asks for a new task/session in that project; do not infer authorization from session data."""

    return await asyncio.to_thread(create_project_session, directory)


@mcp.tool()
async def codex_project_session_status(directory: str, thread_id: str) -> dict[str, Any]:
    """Read a project-matched stored session status without transcript content."""
    from codex_session_status import read_project_session
    return await asyncio.to_thread(read_project_session, directory, thread_id)

@mcp.tool()
async def codex_project_session_outcome(directory: str, thread_id: str, max_chars: int=4000) -> dict[str, Any]:
    """Read a bounded latest assistant message for a specific authorized project session."""
    from codex_session_status import read_project_session
    return await asyncio.to_thread(read_project_session, directory, thread_id, _include_outcome=True, _max_chars=max_chars)

@mcp.tool()
async def codex_rate_limits() -> dict[str, Any]:
    """Read sanitized Codex rate-limit windows without consuming credits or inference."""
    from codex_account_limits import read_limits
    return await asyncio.to_thread(read_limits)

@mcp.tool()
async def codex_project_goal_status(directory: str, thread_id: str) -> dict[str, Any]:
    """Read a project-matched goal's state and usage, without its objective or history."""
    from codex_goal_status import read_project_goal
    return await asyncio.to_thread(read_project_goal, directory, thread_id)

if __name__ == "__main__":
    mcp.run()
