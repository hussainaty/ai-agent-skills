"""Background Codex jobs so another agent (Claude) can delegate work to Codex.

``start`` launches ``codex exec`` (or ``exec resume`` to continue a Codex chat) as a
detached process that outlives the caller, writing JSONL events to a job folder.
``wait`` blocks up to a bound and returns a compact result; a wait timeout never
cancels the job. Job folders hold the prompt, JSONL events and final message, under
the private ``~/.agent-relay/codex-jobs`` folder.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from agent_relay import HOME, _loads, _pid_alive, _read_json, _write_json, parse_output
from codex_session_metadata import resolve_codex

JOBS = HOME / "codex-jobs"
SANDBOXES = ("read-only", "workspace-write")
_DETACHED = (getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
             | getattr(subprocess, "CREATE_NO_WINDOW", 0))
_BREAKAWAY = 0x01000000 if os.name == "nt" else 0  # leave the caller's job object so the job outlives it


def _job_dir(job_id: str) -> Path:
    if not job_id or not all(c.isalnum() or c == "-" for c in job_id):
        raise ValueError("invalid job id")
    path = JOBS / job_id
    if not (path / "job.json").is_file():
        raise KeyError(f"unknown job {job_id}")
    return path


def build_command(codex: str, project: str, sandbox: str, thread_id: str | None, last: Path) -> list[str]:
    if sandbox not in SANDBOXES:
        raise ValueError(f"sandbox must be one of {SANDBOXES}")
    policy = ["-c", 'approval_policy="never"']
    if thread_id:
        return [codex, "exec", "resume", thread_id, "-c", f'sandbox_mode="{sandbox}"', *policy,
                "--skip-git-repo-check", "--json", "-o", str(last), "-"]
    return [codex, "exec", "-C", project, "-s", sandbox, *policy, "--skip-git-repo-check",
            "--json", "-o", str(last), "-"]


def start(project: str, prompt: str, *, sandbox: str = "workspace-write", thread_id: str | None = None,
          popen=subprocess.Popen) -> dict:
    project = str(Path(project).resolve())
    if not Path(project).is_dir():
        raise FileNotFoundError(project)
    if not prompt.strip():
        raise ValueError("prompt is empty")
    job_id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
    folder = JOBS / job_id
    folder.mkdir(parents=True)
    argv = build_command(resolve_codex(), project, sandbox, thread_id, folder / "last.txt")
    (folder / "prompt.txt").write_text(prompt, encoding="utf-8")
    with open(folder / "prompt.txt", "rb") as stdin, open(folder / "events.jsonl", "wb") as out:
        try:
            process = popen(argv, cwd=project, stdin=stdin, stdout=out, stderr=subprocess.STDOUT,
                            creationflags=_DETACHED | _BREAKAWAY, close_fds=True)
        except PermissionError:  # the caller's job forbids breakaway: the job then ends with the caller
            process = popen(argv, cwd=project, stdin=stdin, stdout=out, stderr=subprocess.STDOUT,
                            creationflags=_DETACHED, close_fds=True)
    _write_json(folder / "job.json", {"job_id": job_id, "pid": process.pid, "project": project,
                                      "sandbox": sandbox, "resumed_thread": thread_id, "started": time.time()})
    return {"job_id": job_id, "status": "running", "note": "Use codex_task_wait; a wait timeout does not cancel."}


def result(job_id: str, *, max_chars: int = 6000, alive=_pid_alive) -> dict:
    folder = _job_dir(job_id)
    job = _read_json(folder / "job.json", {})
    try:
        text = (folder / "events.jsonl").read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    thread_id, failed = job.get("resumed_thread"), None
    for line in text.splitlines():
        event = _loads(line)
        if isinstance(event, dict):
            if event.get("type") == "thread.started":
                thread_id = event.get("thread_id")
            elif event.get("type") in ("turn.failed", "error"):
                failed = str(event.get("error") or event.get("message"))[:500]
    running = alive(job["pid"]) if isinstance(job.get("pid"), int) else False
    parsed = parse_output("codex", text)
    try:
        final = (folder / "last.txt").read_text(encoding="utf-8", errors="replace")
    except OSError:
        final = None
    status = "running" if running else ("cancelled" if job.get("cancelled") else
                                        "failed" if failed or final is None else "completed")
    out = {"job_id": job_id, "status": status, "thread_id": thread_id, "limited": parsed["limited"],
           "usage": parsed["usage"], "error": failed,
           "elapsed_s": round(time.time() - job.get("started", time.time()))}
    if not running:
        out["final_message"] = final[-max_chars:] if final else None
    return out


def wait(job_id: str, timeout: float = 600, *, poll: float = 5, alive=_pid_alive) -> dict:
    deadline = time.monotonic() + max(0.0, min(float(timeout), 3000))
    while True:
        current = result(job_id, alive=alive)
        if current["status"] != "running" or time.monotonic() >= deadline:
            return current
        time.sleep(poll)


def cancel(job_id: str) -> dict:
    folder = _job_dir(job_id)
    job = _read_json(folder / "job.json", {})
    pid = job.get("pid")
    if isinstance(pid, int) and _pid_alive(pid):
        if os.name == "nt":  # end the whole tree: codex.exe spawns sandboxed children
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.kill(pid, 15)
        job["cancelled"] = True
        _write_json(folder / "job.json", job)
    return result(job_id)


def list_jobs(limit: int = 10) -> list[dict]:
    folders = sorted((p for p in JOBS.glob("*") if (p / "job.json").is_file()), reverse=True)[:limit]
    return [{k: v for k, v in result(p.name).items() if k != "final_message"} for p in folders]
