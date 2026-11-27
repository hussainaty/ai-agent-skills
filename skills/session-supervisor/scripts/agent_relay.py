"""Automatic Codex <-> Claude relay for one task, driven by a periodic tick.

The relay never injects input into an existing interactive session. It starts a
new headless run (``claude -p`` or ``codex exec``) in the project, pointed at the
task's continuation files, and only when the task is pending, unlocked, within
its hop budget and the target agent is not known to be rate limited. Waiting and
availability checks use no model inference.

State lives in ``<task-dir>/relay.json``; one run at a time is guarded by
``<task-dir>/relay.lock``. Registered task directories are listed in
``~/.agent-relay/tasks.json``. No prompts, transcripts or credentials are stored.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

AGENTS = ("claude", "codex")
HOME = Path(os.environ.get("AGENT_RELAY_HOME", Path.home() / ".agent-relay"))
REGISTRY = HOME / "tasks.json"
DEFAULTS = {"max_hops": 12, "max_no_progress": 2, "run_timeout": 4 * 3600,
            "claude_permission_mode": "auto", "codex_sandbox": "workspace-write",
            "watch_codex_limit": False}
LIMIT_TEXT = re.compile(r"rate.?limit|usage.?limit|limit (?:reached|exceeded)|quota|"
                        r"rateLimitExceeded|usageLimitExceeded|out of (?:extra )?usage", re.I)
UNKNOWN_LIMIT_BACKOFF = 1800

PROMPT = """You were started automatically by the agent relay to continue an unfinished task.
Task directory: {task_dir}
{resumed}1. Read {task_dir}{sep}{prompt_file} and {task_dir}{sep}AI_CONTINUATION_CONTEXT.md if they exist.
2. Verify those claims against the current Git status, diff and tests before relying on them.
3. Continue the highest-priority unfinished work. Preserve settled decisions and uncommitted user work.
   Do not push, publish, deploy or spend money unless AI_CONTINUATION_CONTEXT.md records that authorization.
   If {task_dir}{sep}{tasks_file} exists, it is the ordered checklist: work on the first item whose
   "passes" is not true, set "passes": true only after you ran its check and saw it pass, and never
   delete, reword or reorder items.
4. Before you stop, update AI_CONTINUATION_CONTEXT.md with what changed, tests run and the exact next action.
   Then tell the relay what happens next by writing ONE JSON object to {task_dir}{sep}relay-signal.json:
   - Task fully done and verified: {{"action": "complete"}} (refused while any {tasks_file} item is not passing)
   - Unfinished and you are near your limit: write {other_prompt} for {other}, then {{"action": "handoff", "to": "{other}"}}
   - Blocked on a human decision: record it in ENGINEER_DECISIONS.md, then {{"action": "stop", "reason": "<one line>"}}
   - Unfinished with capacity left: keep working instead of stopping. If you must stop, write no signal and you will be restarted.
   Do not edit relay.json.
"""
SIGNAL = "relay-signal.json"
TASKS = "tasks.json"  # optional checklist: [{"id": ..., "check": ..., "passes": false}, ...]
RESUMED = ("Your previous turn in this conversation stopped at a usage limit, which has now reset. "
           "Continue the same task from where you stopped.\n")
CODEX_QUIET_SECONDS = 120  # a chat must be this quiet after its last turn before it is resumed


def _now() -> float:
    return time.time()


def _read_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path: Path, value) -> None:
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load(task_dir: Path) -> dict:
    state = _read_json(task_dir / "relay.json", {})
    for key, value in DEFAULTS.items():
        state.setdefault(key, value)
    state.setdefault("state", "idle")
    state.setdefault("hops", 0)
    state.setdefault("no_progress", 0)
    state.setdefault("history", [])
    return state


def save(task_dir: Path, state: dict) -> None:
    state["history"] = state["history"][-20:]
    _write_json(task_dir / "relay.json", state)


def other(agent: str) -> str:
    return AGENTS[1 - AGENTS.index(agent)]


# ---------- lock ----------

def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def acquire(task_dir: Path) -> bool:
    lock = task_dir / "relay.lock"
    for _ in range(2):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            held = _read_json(lock, {})
            if isinstance(held.get("pid"), int) and _pid_alive(held["pid"]):
                return False
            lock.unlink(missing_ok=True)  # stale: holder exited
            continue
        with os.fdopen(fd, "w") as handle:
            json.dump({"pid": os.getpid(), "at": _now()}, handle)
        return True
    return False


def release(task_dir: Path) -> None:
    (task_dir / "relay.lock").unlink(missing_ok=True)


# ---------- availability ----------

def codex_limit(read_limits=None) -> tuple[bool, float | None]:
    """(limited, reset_at). Unreadable limits are treated as available; the run reports a real limit."""
    try:
        if read_limits is None:
            from codex_account_limits import read_limits
        info = (read_limits() or {}).get("rate_limits") or {}
    except Exception:
        return False, None
    windows = [w for w in (info.get("primary"), info.get("secondary")) if w]
    full = [w for w in windows if (w.get("usedPercent") or 0) >= 100]
    if info.get("rateLimitReachedType") or full:
        resets = [w["resetsAt"] for w in (full or windows) if w.get("resetsAt")]
        return True, max(resets) if resets else None
    return False, None


def fingerprint(project: Path, task_dir: Path) -> str:
    digest = hashlib.sha256()
    for args in (["rev-parse", "HEAD"], ["status", "--porcelain"], ["diff"]):
        try:
            out = subprocess.run(["git", "-C", str(project), *args], capture_output=True,
                                 timeout=60, creationflags=_NO_WINDOW).stdout
        except (OSError, subprocess.TimeoutExpired):
            out = b""
        digest.update(out)
    for name in ("AI_CONTINUATION_CONTEXT.md", "notebook.md", TASKS):
        try:
            digest.update((task_dir / name).read_bytes())
        except OSError:
            pass
    return digest.hexdigest()


# ---------- Codex chat auto-continue ----------

def codex_rollout(thread: str) -> Path | None:
    root = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions"
    found = sorted(root.glob(f"*/*/*/rollout-*-{thread}.jsonl"))
    return found[-1] if found else None


def codex_thread_stop(thread: str, *, now=_now, rollout=codex_rollout) -> dict | None:
    """The chat's last finished turn, or None while a turn may be running or the chat is unknown.

    A limit stop is the host's own record: task_complete with codex_error_info usage_limit_exceeded.
    """
    path = rollout(thread)
    if path is None:
        return None
    try:
        quiet = now() - path.stat().st_mtime
        with open(path, "rb") as handle:
            handle.seek(max(0, handle.seek(0, 2) - 262144))
            lines = handle.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        event = _loads(line)
        if not isinstance(event, dict) or event.get("type") != "event_msg":
            continue
        payload = event.get("payload") or {}
        if payload.get("type") == "task_started":
            return None  # running, or killed mid-turn: never resume blindly
        if payload.get("type") == "task_complete":
            error = payload.get("error") or {}
            return {"turn_id": payload.get("turn_id"), "quiet": quiet,
                    "limited": error.get("codex_error_info") == "usage_limit_exceeded"}
    return None


def codex_thread_cwd(thread: str) -> str | None:
    path = codex_rollout(thread)
    try:
        with open(path, encoding="utf-8") as handle:
            first = _loads(handle.readline()) or {}
    except (OSError, TypeError):
        return None
    return (first.get("payload") or {}).get("cwd")


# ---------- dispatch ----------

_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def build_prompt(agent: str, task_dir: Path, resumed: bool = False) -> str:
    names = {"claude": "CLAUDE_CONTINUATION_PROMPT.md", "codex": "CODEX_CONTINUATION_PROMPT.md"}
    return PROMPT.format(task_dir=task_dir, sep=os.sep, prompt_file=names[agent], other=other(agent),
                         other_prompt=names[other(agent)], tasks_file=TASKS, resumed=RESUMED if resumed else "")


def unfinished_items(task_dir: Path) -> list[str]:
    """Ids of tasks.json items not marked passing. No file, or an unreadable one, means no checklist."""
    data = _read_json(task_dir / TASKS, None)
    items = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return [str(item.get("id", item.get("name", i + 1))) for i, item in enumerate(items)
            if isinstance(item, dict) and item.get("passes") is not True]


def apply_signal(task_dir: Path, state: dict) -> bool:
    """Apply and consume an agent-written relay-signal.json. Returns True if one was valid.

    An agent's "complete" is a claim: it is refused (treated as no signal) while the task's
    tasks.json checklist has items that are not passing. A human's CLI ``complete`` is not gated.
    """
    path = task_dir / SIGNAL
    signal = _read_json(path, None)
    path.unlink(missing_ok=True)
    if not isinstance(signal, dict):
        return False
    action, reason = signal.get("action"), str(signal.get("reason", ""))[:300]
    if action == "complete" and (open_items := unfinished_items(task_dir)):
        state["refused"] = (f"complete refused: {len(open_items)} {TASKS} item(s) not passing "
                            f"({', '.join(open_items[:3])})")
        return False
    if action == "complete":
        state.update(state="complete", reason=reason)
    elif action == "stop":
        state.update(state="stopped", reason=reason or "agent requested stop")
    elif action == "handoff" and signal.get("to") in AGENTS:
        state.update(state="pending", next=signal["to"], reason=f"handoff to {signal['to']}")
    else:
        return False
    return True


def command(agent: str, state: dict, task_dir: Path) -> list[str]:
    if agent == "claude":
        from claude_adapter import _resolve_cli
        return [_resolve_cli(), "-p", "--permission-mode", state["claude_permission_mode"],
                "--output-format", "json", "--add-dir", str(task_dir)]
    from codex_session_metadata import resolve_codex
    if state.get("codex_thread"):  # continue the same Codex chat; resume takes sandbox only via -c
        return [resolve_codex(), "exec", "resume", state["codex_thread"],
                "-c", f'sandbox_mode="{state["codex_sandbox"]}"', "-c", 'approval_policy="never"',
                "-c", f"sandbox_workspace_write.writable_roots=[{json.dumps(str(task_dir))}]",
                "--skip-git-repo-check", "--json", "-"]
    return [resolve_codex(), "exec", "-C", state["project"], "-s", state["codex_sandbox"],
            "-c", 'approval_policy="never"', "--add-dir", str(task_dir), "--skip-git-repo-check",
            "--json", "-"]


def run_agent(agent: str, state: dict, task_dir: Path) -> dict:
    """Run one headless session to exit. Returns {'exit', 'limited', 'usage'}."""
    log = task_dir / f"relay-{agent}-last.log"
    resumed = agent == "codex" and bool(state.get("codex_thread"))
    with open(log, "wb") as out:
        try:
            proc = subprocess.run(command(agent, state, task_dir), cwd=state["project"],
                                  input=build_prompt(agent, task_dir, resumed).encode("utf-8"), stdout=out,
                                  stderr=subprocess.STDOUT, timeout=state["run_timeout"],
                                  creationflags=_NO_WINDOW)
            code = proc.returncode
        except subprocess.TimeoutExpired:
            code = "timeout"
    text = log.read_text(encoding="utf-8", errors="replace")
    return {"exit": code, **parse_output(agent, text)}


def parse_output(agent: str, text: str) -> dict:
    usage, limited = None, False
    if agent == "claude":
        start = text.find("{")
        result = _loads(text[start:]) if start >= 0 else None
        if isinstance(result, dict):
            u = result.get("usage") or {}
            usage = {k: u.get(k) for k in ("input_tokens", "cache_creation_input_tokens",
                                           "cache_read_input_tokens", "output_tokens")}
            usage["cost_usd"] = result.get("total_cost_usd")
            limited = bool(result.get("is_error")) and bool(LIMIT_TEXT.search(str(result.get("result"))))
        else:
            limited = bool(LIMIT_TEXT.search(text[-4000:]))
    else:
        totals: dict = {}
        for line in text.splitlines():
            event = _loads(line)
            if not isinstance(event, dict):
                continue
            if event.get("type") == "turn.completed":
                for key, value in (event.get("usage") or {}).items():
                    if isinstance(value, int):
                        totals[key] = totals.get(key, 0) + value
            elif event.get("type") in ("error", "turn.failed") and LIMIT_TEXT.search(json.dumps(event)):
                limited = True
        usage = totals or None
    return {"limited": limited, "usage": usage}


def _loads(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return None


def tick_task(task_dir: Path, *, now=_now, runner=run_agent, limits=codex_limit,
              fingerprinter=fingerprint, thread_stop=None) -> str:
    """Advance one task by at most one run. Returns a short outcome string."""
    state = load(task_dir)
    if "project" not in state:
        return "unregistered"
    thread = state.get("codex_thread")
    thread_stop = thread_stop or (lambda t: codex_thread_stop(t, now=now))
    if thread and state["state"] == "complete":
        state["state"] = "idle"  # a watched chat keeps being watched for its next limit stop
    stop = thread_stop(thread) if thread and state["state"] == "idle" else None
    if stop and stop["limited"] and stop["turn_id"] != state.get("continued_turn"):
        state.update(state="pending", next="claude" if state["watch_codex_limit"] else "codex",
                     continued_turn=stop["turn_id"], hops=0, no_progress=0, not_before=0,
                     reason="codex chat stopped at a usage limit")
    elif state["state"] == "idle" and state["watch_codex_limit"] and not thread and limits()[0]:
        state.update(state="pending", next="claude", reason="codex rate limited")
    if state["state"] != "pending":
        return state["state"]
    if now() < state.get("not_before", 0):
        return "waiting"
    if state["hops"] >= state["max_hops"]:
        state.update(state="stopped", reason="hop budget exhausted")
        save(task_dir, state)
        return "stopped"
    agent = state.get("next") or "claude"
    if agent == "codex":
        limited, reset = limits()
        if limited:
            state["not_before"] = reset or now() + UNKNOWN_LIMIT_BACKOFF
            save(task_dir, state)
            return "waiting"
        if thread:
            stop = thread_stop(thread)
            if stop is None or stop["quiet"] < CODEX_QUIET_SECONDS:
                save(task_dir, state)
                return "busy"  # someone is using the chat; never add a turn to it mid-flight
    if not acquire(task_dir):
        return "locked"
    try:
        (task_dir / SIGNAL).unlink(missing_ok=True)  # never act on a signal left from an earlier run
        before = fingerprinter(Path(state["project"]), task_dir)
        state.update(state="running", agent=agent, started=now(), hops=state["hops"] + 1)
        save(task_dir, state)
        result = runner(agent, state, task_dir)
        after_state = load(task_dir)  # a human may have run handoff/complete/stop meanwhile
        signalled = apply_signal(task_dir, after_state)
        progressed = fingerprinter(Path(state["project"]), task_dir) != before
        refused = after_state.pop("refused", None)
        entry = {"agent": agent, "start": state["started"], "end": now(), "exit": result["exit"],
                 "limited": result["limited"], "progressed": progressed, "usage": result["usage"]}
        if refused:
            entry["refused"] = refused
        after_state["history"].append(entry)
        after_state["no_progress"] = 0 if progressed else after_state["no_progress"] + 1
        if signalled or after_state["state"] in ("complete", "stopped"):
            pass
        elif after_state["state"] == "pending" and after_state.get("handoff_at", 0) >= state["started"]:
            pass  # explicit handoff via the CLI during the run
        elif result["limited"]:
            target = other(agent)
            after_state.update(state="pending", next=target, reason=f"{agent} hit a usage limit")
            if not progressed:
                after_state["no_progress"] = 0  # a limit is not a lack of progress
        elif after_state["no_progress"] >= after_state["max_no_progress"]:
            after_state.update(state="stopped", reason=refused or "no progress in repeated runs")
        else:
            after_state.update(state="pending", next=agent, reason=refused or "run ended without handoff; continuing")
        if after_state["state"] == "pending" and result["limited"] and after_state["next"] == agent:
            after_state["not_before"] = now() + UNKNOWN_LIMIT_BACKOFF
        save(task_dir, after_state)
        return f"ran {agent}: {after_state['state']}"
    finally:
        release(task_dir)


# ---------- CLI ----------

def _registry() -> list[str]:
    return _read_json(REGISTRY, [])


def cmd_register(args) -> None:
    task_dir = Path(args.task_dir).resolve()
    state = load(task_dir)
    state["project"] = str(Path(args.project).resolve())
    for key in ("max_hops", "claude_permission_mode", "codex_sandbox", "codex_thread"):
        if getattr(args, key) is not None:
            state[key] = getattr(args, key)
    state["watch_codex_limit"] = args.watch_codex_limit
    save(task_dir, state)
    HOME.mkdir(parents=True, exist_ok=True)
    tasks = [t for t in _registry() if Path(t) != task_dir] + [str(task_dir)]
    _write_json(REGISTRY, tasks)
    print(f"registered {task_dir}")


def _set(task_dir: str, **fields) -> None:
    path = Path(task_dir).resolve()
    state = load(path)
    state.update(fields)
    save(path, state)


def main(argv=None) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("register", help="add a task directory to the relay")
    p.add_argument("--task-dir", required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--max-hops", type=int)
    p.add_argument("--claude-permission-mode")
    p.add_argument("--codex-sandbox")
    p.add_argument("--watch-codex-limit", action="store_true",
                   help="hand an idle task to Claude automatically when Codex is rate limited")
    p.add_argument("--codex-thread", help="continue this Codex chat (exec resume) instead of a new one")
    p = sub.add_parser("watch-codex", help="auto-continue a Codex chat whenever it stops at a usage limit")
    p.add_argument("--thread", required=True, help="Codex session id")
    p.add_argument("--project", help="defaults to the chat's working directory")
    p.add_argument("--claude-takeover", action="store_true",
                   help="let Claude work while Codex waits for its reset, then hand back to the chat")
    p = sub.add_parser("handoff", help="request a run of the other agent")
    p.add_argument("--task-dir", required=True)
    p.add_argument("--to", choices=AGENTS, required=True)
    p.add_argument("--reset", action="store_true", help="also reset hop and no-progress counters")
    for name in ("complete", "stop"):
        p = sub.add_parser(name)
        p.add_argument("--task-dir", required=True)
        p.add_argument("--reason", default="")
    sub.add_parser("tick", help="advance every registered task once (for the scheduler)")
    sub.add_parser("status")
    args = parser.parse_args(argv)

    if args.cmd == "register":
        cmd_register(args)
    elif args.cmd == "watch-codex":
        project = args.project or codex_thread_cwd(args.thread)
        if not project:
            parser.error("chat not found or has no working directory; pass --project")
        task_dir = HOME / "threads" / args.thread
        task_dir.mkdir(parents=True, exist_ok=True)
        cmd_register(argparse.Namespace(task_dir=str(task_dir), project=project, max_hops=None,
                                        claude_permission_mode=None, codex_sandbox=None,
                                        codex_thread=args.thread, watch_codex_limit=args.claude_takeover))
    elif args.cmd == "handoff":
        extra = {"hops": 0, "no_progress": 0} if args.reset else {}
        _set(args.task_dir, state="pending", next=args.to, handoff_at=_now(), not_before=0,
             reason=f"handoff to {args.to}", **extra)
    elif args.cmd in ("complete", "stop"):
        _set(args.task_dir, state="complete" if args.cmd == "complete" else "stopped", reason=args.reason)
    elif args.cmd == "tick":
        for task in _registry():
            try:
                outcome = tick_task(Path(task))
            except Exception as exc:  # one broken task must not block the others
                outcome = f"error: {exc}"
            print(task, outcome)
            if outcome.startswith(("ran", "error")):  # scheduled ticks have no console
                HOME.mkdir(parents=True, exist_ok=True)
                with open(HOME / "relay.log", "a", encoding="utf-8") as log:
                    log.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {task} {outcome}\n")
    elif args.cmd == "status":
        for task in _registry():
            s = load(Path(task))
            print(task, s["state"], s.get("next"), f"hops={s['hops']}/{s['max_hops']}", s.get("reason", ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
