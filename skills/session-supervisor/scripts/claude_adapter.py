"""Project-scoped Claude Code session discovery and explicit, one-shot resume.

Uses supported Claude CLI / optional Agent SDK APIs. No transcript output,
credential storage, automatic retry, polling or scheduler. Session state can
change after discovery, so this API does not claim atomic idle-only dispatch.
"""
from __future__ import annotations

import importlib
import json
import math
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from typing import Any


class ClaudeSessionError(RuntimeError):
    """A sanitized failure, deliberately excluding child process output."""


def _project(value: Any) -> str:
    try:
        p = Path(value).expanduser().resolve(strict=True)
    except (TypeError, OSError, ValueError) as exc:
        raise ValueError('project must be an existing absolute directory') from exc
    if not Path(value).is_absolute() or not p.is_dir():
        raise ValueError('project must be an existing absolute directory')
    return str(p)


def _same_project(value: Any, project: str) -> bool:
    if not isinstance(value, str) or not os.path.isabs(value):
        return False
    try:
        return os.path.normcase(str(Path(value).resolve())) == os.path.normcase(project)
    except (OSError, ValueError):
        return False


def _uuid(value: Any) -> str:
    if not isinstance(value, str) or len(value) != 36:
        raise ValueError('a full session UUID is required')
    try:
        result = str(uuid.UUID(value))
    except (ValueError, AttributeError) as exc:
        raise ValueError('a full session UUID is required') from exc
    if value.lower() != result:
        raise ValueError('a canonical full session UUID is required')
    return result


def _timeout(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 3600:
        raise ValueError('timeout must be finite and between 0 and 3600 seconds')
    return float(value)


def _resolve_cli() -> str:
    """Use a real executable; never send untrusted arguments through a shell."""
    if os.name != 'nt':
        found = shutil.which('claude')
        if found:
            return found
    else:
        found = shutil.which('claude.exe')
        if found:
            return found
        shim = shutil.which('claude.cmd')
        if shim:
            native = Path(shim).parent / 'node_modules' / '@anthropic-ai' / 'claude-code' / 'bin' / 'claude.exe'
            if native.is_file():
                return str(native)
    raise ClaudeSessionError('Claude Code native executable is unavailable')


_MAX_CAPTURE_BYTES = 4 * 1024 * 1024


def _run_files(argv, *, project, timeout, input_text):
    """Bounded-memory subprocess capture without inherited PIPE EOF hangs.

    OS temporary files are automatically removed on close, subject to native
    handle lifetime. A monitor terminates only this CLI process on timeout or
    excessive output; other Claude processes may be shared and are not killed.
    """
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    with tempfile.TemporaryFile(mode='w+b') as input_file, tempfile.TemporaryFile(mode='w+b') as output_file:
        input_file.write(input_text.encode('utf-8'))
        input_file.flush(); input_file.seek(0)
        process = subprocess.Popen(argv, cwd=project, stdin=input_file, stdout=output_file,
                                   stderr=subprocess.DEVNULL, shell=False, creationflags=flags)
        deadline = time.monotonic() + timeout
        try:
            while True:
                if os.fstat(output_file.fileno()).st_size > _MAX_CAPTURE_BYTES:
                    raise TimeoutError('Claude output exceeded the capture limit; outcome unknown')
                code = process.poll()
                if code is not None:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError('Claude command timed out; outcome may be unknown')
                time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            output_file.seek(0)
            raw = output_file.read(_MAX_CAPTURE_BYTES + 1)
            if len(raw) > _MAX_CAPTURE_BYTES:
                raise TimeoutError('Claude output exceeded the capture limit; outcome unknown')
            return subprocess.CompletedProcess(argv, code, raw.decode('utf-8', errors='replace'), '')
        except OSError as exc:
            raise TimeoutError('Claude process outcome unknown; inspect before retrying') from exc
        finally:
            if process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=0.5)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        process.kill()
                        process.wait(timeout=0.5)
                    except (OSError, subprocess.TimeoutExpired):
                        pass


def _run(args: list[str], *, project: str | None = None, runner=None, timeout: float = 20, input_text: str = ""):
    argv = [_resolve_cli(), *args]
    duration = _timeout(timeout)
    try:
        if runner is None:
            return _run_files(argv, project=project, timeout=duration, input_text=input_text)
        return runner(argv, cwd=project, timeout=duration,
                      capture_output=True, input=input_text, text=True, encoding='utf-8', errors='replace',
                      check=False, shell=False)
    except subprocess.TimeoutExpired as exc:
        raise TimeoutError('Claude command timed out; outcome may be unknown') from exc
    except TimeoutError:
        raise
    except OSError as exc:
        raise ClaudeSessionError('Claude Code could not be launched') from exc


def _json_result(completed: Any) -> Any:
    if completed.returncode != 0:
        raise ClaudeSessionError('Claude command failed; inspect the CLI directly for details')
    try:
        return json.loads(completed.stdout)
    except (ValueError, TypeError) as exc:
        raise ClaudeSessionError('Claude returned invalid JSON') from exc


def probe(*, runner=None, timeout: float = 20) -> dict[str, Any]:
    """Read CLI version/auth state; no inference, no credential values."""
    version = _run(['--version'], runner=runner, timeout=timeout)
    if version.returncode != 0:
        raise ClaudeSessionError('Claude version probe failed')
    text = version.stdout.strip()
    # The installed CLI labels its version as N.N.N (Claude Code).
    match = re.fullmatch(r'(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?) \(Claude Code\)', text)
    version_value = match.group(1) if match else None
    auth = _run(['auth', 'status'], runner=runner, timeout=timeout)
    try:
        info = json.loads(auth.stdout)
    except (ValueError, TypeError):
        info = {}
    # auth status returns exit 1 when signed out; preserve unknown if malformed.
    logged_in = info.get('loggedIn') if isinstance(info, dict) else None
    return {'version': version_value, 'authenticated': logged_in if isinstance(logged_in, bool) else None,
            'history_sdk_available': _sdk() is not None,
            'note': 'Authentication does not establish provider entitlement or free pricing.'}


def _sdk():
    try:
        return importlib.import_module('claude_agent_sdk')
    except ImportError:
        return None


def _field(row: Any, key: str):
    return row.get(key) if isinstance(row, dict) else getattr(row, key, None)


def list_sessions(project_dir: str, *, runner=None, sdk=None, timeout: float = 20, limit: int = 50) -> dict[str, Any]:
    """Return bounded project-matched IDs/status; never return summaries or prompts.

    Native CLI covers live sessions and completed background sessions, not all
    saved interactive history. The optional supported SDK can add saved history;
    internally it reads portions of local transcripts to build metadata.
    """
    project = _project(project_dir)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        raise ValueError('limit must be an integer from 1 to 100')
    rows = _json_result(_run(['agents', '--json', '--all', '--cwd', project],
                             project=project, runner=runner, timeout=timeout))
    if not isinstance(rows, list):
        raise ClaudeSessionError('Claude session listing returned an unexpected shape')
    by_id = {}
    unidentified_project_entries = 0
    duplicate_session_ids = set()
    for row in rows:
        if not isinstance(row, dict) or not _same_project(row.get('cwd'), project):
            continue
        try:
            sid = _uuid(row.get('sessionId'))
        except ValueError:
            unidentified_project_entries += 1
            continue
        kind = row.get('kind') if row.get('kind') in ('interactive', 'background') else 'unknown'
        raw_status, raw_state, raw_wait = row.get('status'), row.get('state'), row.get('waitingFor')
        status = raw_status if raw_status in ('busy', 'waiting', 'idle') else ('unknown' if raw_status is not None else None)
        state = raw_state if raw_state in ('working', 'blocked', 'done', 'failed', 'stopped') else ('unknown' if raw_state is not None else None)
        wait = raw_wait if raw_wait in ('permission prompt', 'input needed', 'sandbox request', 'worker request', 'dialog open') else ('other' if raw_wait is not None else None)
        short_id = row.get('id')
        background_id = short_id if kind == 'background' and isinstance(short_id, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', short_id) else None
        # Any pid field, even malformed, means the process state is not known stopped.
        alive = row.get('pid') is not None
        if sid in by_id:
            duplicate_session_ids.add(sid)
            continue
        by_id[sid] = {'id': sid, 'kind': kind, 'status': status, 'state': state,
                      'waiting_for': wait, 'process_alive_reported': alive, 'source': 'claude_agents',
                      'background_id': background_id}
    sdk = _sdk() if sdk is None else sdk
    history = 'unavailable'
    if sdk is not None and callable(getattr(sdk, 'list_sessions', None)):
        try:
            history_rows = sdk.list_sessions(directory=project, limit=limit)
            history = 'available'
            for row in history_rows:
                if not _same_project(_field(row, 'cwd'), project):
                    continue
                try:
                    sid = _uuid(_field(row, 'session_id'))
                except ValueError:
                    continue
                if sid not in by_id:
                    by_id[sid] = {'id': sid, 'kind': 'unknown', 'status': None, 'state': None,
                                  'waiting_for': None, 'process_alive_reported': False, 'source': 'sdk_history',
                                  'background_id': None}
        except Exception:
            history = 'unavailable'
    return {'sessions': list(by_id.values())[:limit], 'history': history,
            'unidentified_project_entries': unidentified_project_entries,
            'duplicate_session_ids': sorted(duplicate_session_ids),
            'note': 'Metadata only; status can change after this snapshot. No transcripts are returned.'}


def _outcome_limit(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 8000:
        raise ValueError('max_outcome_chars must be an integer from 1 to 8000')
    return value


def _redact_common_secrets(text: str) -> str:
    # Best effort, not a comprehensive privacy filter. Outcomes can contain
    # project data and must only be requested by an authorized caller.
    text = re.sub(r'(?i)\b(?:sk-proj-|sk-ant-|sk-|gsk_|ghp_|github_pat_)[A-Za-z0-9_-]{12,}', '[REDACTED]', text)
    text = re.sub(r'(?i)(\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)["\']?[^\s"\',;]+', r'\1[REDACTED]', text)
    return text


def _result(sid: str, proc: Any, include_outcome: bool, max_outcome_chars: int) -> dict[str, Any]:
    if proc.returncode != 0:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Command failed; inspect session before retrying.'}
    try:
        response = json.loads(proc.stdout)
    except (TypeError, ValueError):
        return {'session_id': sid, 'state': 'unknown', 'note': 'Unparseable result; inspect before retrying.'}
    if not isinstance(response, dict) or response.get('session_id') != sid or not isinstance(response.get('is_error'), bool):
        return {'session_id': sid, 'state': 'unknown', 'note': 'Missing or mismatched session result; inspect before retrying.'}
    if response['is_error'] or response.get('subtype') != 'success':
        return {'session_id': sid, 'state': 'failed', 'note': 'Claude returned an error result; no automatic retry.'}
    result = {'session_id': sid, 'state': 'completed', 'note': 'Claude returned a successful result; task quality still requires verification.'}
    if include_outcome:
        value = response.get('result')
        result['outcome'] = _redact_common_secrets(value)[:max_outcome_chars] if isinstance(value, str) else None
        result['outcome_note'] = 'Authorized output may contain private project data; secret masking is best effort.'
    return result


def _authorization(prompt: str, authorized: bool, model_use_authorized: bool, include_outcome: bool, max_outcome_chars: int):
    if authorized is not True or model_use_authorized is not True:
        raise PermissionError('specific session and model use must be authorized')
    if not isinstance(include_outcome, bool):
        raise TypeError('include_outcome must be boolean')
    _outcome_limit(max_outcome_chars)
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 16000 or '\x00' in prompt:
        raise ValueError('prompt must be nonempty and at most 16000 characters')


_RUNNING_PROCESSES: dict[int, Any] = {}
_RUNNING_LOCK = threading.Lock()


def _retain_until_exit(process: Any) -> None:
    """Reap this observed process if it exits while the supervisor is alive."""
    with _RUNNING_LOCK:
        _RUNNING_PROCESSES[process.pid] = process
    def reap():
        try:
            process.wait()
        except Exception:
            pass
        finally:
            with _RUNNING_LOCK:
                _RUNNING_PROCESSES.pop(process.pid, None)
    try:
        threading.Thread(target=reap, name='claude-session-reaper', daemon=True).start()
    except RuntimeError:
        # Do not retain a permanent handle when thread creation fails; never
        # kill the worker to reclaim it. OS/process cleanup then applies.
        with _RUNNING_LOCK:
            _RUNNING_PROCESSES.pop(process.pid, None)


def _launch_session_preserving(project: str, sid: str, args: list[str], prompt: str,
                               timeout: float, include_outcome: bool) -> dict[str, Any]:
    """Start one Claude process; a supervisor wait timeout never stops it.

    stdout and stderr go to DEVNULL so a supervisor exit cannot break a PIPE and
    an unattended worker cannot grow an output file without bound. This means
    CLI outcome text is not available through this path. Claude's own session
    storage remains authoritative for later project-scoped status/summary reads.
    Survival across parent process, host or OS shutdown is not guaranteed.
    """
    argv = [_resolve_cli(), *args]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    try:
        with tempfile.TemporaryFile(mode='w+b') as input_file:
            input_file.write(prompt.encode('utf-8'))
            input_file.flush(); input_file.seek(0)
            process = subprocess.Popen(argv, cwd=project, stdin=input_file,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       shell=False, creationflags=flags)
    except OSError as exc:
        raise ClaudeSessionError('Claude Code could not be launched') from exc
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        _retain_until_exit(process)
        result = {'session_id': sid, 'state': 'running_unobserved', 'pid': process.pid,
                  'note': 'Supervisor stopped waiting and did not terminate the Claude process; check native session status. The worker may have finished since this snapshot.'}
    except OSError:
        _retain_until_exit(process)
        result = {'session_id': sid, 'state': 'unknown', 'pid': process.pid,
                  'note': 'Wait failed after launch; inspect session before retrying.'}
    else:
        result = {'session_id': sid, 'state': 'finished_unverified', 'pid': process.pid,
                  'exit_code': code,
                  'note': 'The process exited; output was not captured and completion of the task is unverified.'}
    if include_outcome:
        result['outcome'] = None
        result['outcome_note'] = 'This detached-safe path does not capture CLI output; inspect the authorized session or SDK summary.'
    return result


def resume_session(project_dir: str, session_id: str, prompt: str, *, authorized: bool = False,
                   model_use_authorized: bool = False, include_outcome: bool = False,
                   max_outcome_chars: int = 2000, runner=None, sdk=None, timeout: float = 300) -> dict[str, Any]:
    """One explicit resume; prompt via stdin, no retry, no atomic idle claim.

    The two authorization flags mean the human authorized this particular
    session/prompt and provider-model usage. Pricing cannot be inferred here.
    Optional outcome is bounded and secret masking is best effort only.
    """
    project, sid = _project(project_dir), _uuid(session_id)
    _timeout(timeout)
    _authorization(prompt, authorized, model_use_authorized, include_outcome, max_outcome_chars)
    snapshot = list_sessions(project, runner=runner, sdk=sdk, timeout=min(float(timeout), 20), limit=100)
    if snapshot['unidentified_project_entries']:
        raise ClaudeSessionError('project contains sessions without verifiable IDs; no prompt was sent')
    if sid in snapshot['duplicate_session_ids']:
        raise ClaudeSessionError('duplicate session entries; no prompt was sent')
    matches = [s for s in snapshot['sessions'] if s['id'] == sid]
    if len(matches) != 1:
        raise ClaudeSessionError('session not verifiably present in the requested project')
    session = matches[0]
    if (session['source'] != 'claude_agents' or session['kind'] != 'background' or
            session['state'] not in ('done', 'failed', 'stopped') or
            session['process_alive_reported'] or session['status'] is not None or
            session['waiting_for'] is not None):
        raise ClaudeSessionError('session is active, waiting or not confirmed stopped; no prompt was sent')
    args = ['--resume', sid, '--print', '--output-format', 'json']
    if runner is None:
        return _launch_session_preserving(project, sid, args, prompt, float(timeout), include_outcome)
    try:
        proc = _run(args, project=project, runner=runner, timeout=timeout, input_text=prompt)
    except TimeoutError:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Acceptance may have occurred; inspect before retrying.'}
    return _result(sid, proc, include_outcome, max_outcome_chars)


def start_session(project_dir: str, prompt: str, *, authorized: bool = False,
                  model_use_authorized: bool = False, include_outcome: bool = False,
                  max_outcome_chars: int = 2000, runner=None, timeout: float = 300) -> dict[str, Any]:
    """Start one new Claude session only on an explicitly authorized request.

    A generated full UUID is returned even when the outcome is unknown, so the
    caller can inspect it rather than accidentally creating a second session.
    """
    project = _project(project_dir)
    _timeout(timeout)
    _authorization(prompt, authorized, model_use_authorized, include_outcome, max_outcome_chars)
    sid = str(uuid.uuid4())
    args = ['--session-id', sid, '--print', '--output-format', 'json']
    if runner is None:
        return _launch_session_preserving(project, sid, args, prompt, float(timeout), include_outcome)
    try:
        proc = _run(args, project=project, runner=runner, timeout=timeout, input_text=prompt)
    except TimeoutError:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Creation may have occurred; inspect this ID before retrying.'}
    return _result(sid, proc, include_outcome, max_outcome_chars)


def session_status(project_dir: str, session_id: str, *, runner=None, sdk=None, timeout: float = 20) -> dict[str, Any]:
    """Return a fresh project-matched metadata snapshot, or fail closed."""
    sid = _uuid(session_id)
    snapshot = list_sessions(project_dir, runner=runner, sdk=sdk, timeout=timeout, limit=100)
    if snapshot['unidentified_project_entries'] or sid in snapshot['duplicate_session_ids']:
        raise ClaudeSessionError('project session identity is ambiguous')
    matches = [row for row in snapshot['sessions'] if row['id'] == sid]
    if len(matches) != 1:
        raise ClaudeSessionError('session not verifiably present in the requested project')
    return {'session': matches[0], 'note': 'Snapshot only; status can change immediately.'}


def stop_session(project_dir: str, session_id: str, *, authorized: bool = False, runner=None,
                 sdk=None, timeout: float = 20) -> dict[str, Any]:
    """Request a stop only for a specifically authorized background session.

    CLI success is a request acknowledgment, not confirmation that the target
    has stopped; callers should check session_status afterward.
    """
    project, sid = _project(project_dir), _uuid(session_id)
    _timeout(timeout)
    if authorized is not True:
        raise PermissionError('a stop of this specific session must be authorized')
    row = session_status(project, sid, runner=runner, sdk=sdk, timeout=timeout)['session']
    if row['kind'] != 'background' or not row.get('background_id'):
        raise ClaudeSessionError('no verified background process ID for this session')
    try:
        proc = _run(['stop', row['background_id']], project=project, runner=runner, timeout=timeout)
    except TimeoutError:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Stop outcome unknown; inspect before retrying.'}
    if proc.returncode != 0:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Stop was not confirmed; inspect before retrying.'}
    return {'session_id': sid, 'state': 'stop_requested', 'note': 'Check session status to confirm it stopped.'}


def _sdk_verified_session(project: str, sid: str, sdk: Any):
    if sdk is None or not callable(getattr(sdk, 'get_session_info', None)):
        raise ClaudeSessionError('Claude Agent SDK session metadata is unavailable')
    try:
        row = sdk.get_session_info(sid, directory=project)
    except Exception as exc:
        raise ClaudeSessionError('Claude session metadata lookup failed') from None
    try:
        actual_id = _uuid(_field(row, 'session_id'))
    except ValueError:
        raise ClaudeSessionError('session is not verified for the requested project') from None
    if actual_id != sid or not _same_project(_field(row, 'cwd'), project):
        raise ClaudeSessionError('session is not verified for the requested project')
    return row


def _organize(project_dir: str, session_id: str, value: str | None, *, action: str,
              authorized: bool = False, sdk=None) -> dict[str, Any]:
    project, sid = _project(project_dir), _uuid(session_id)
    if authorized is not True:
        raise PermissionError('this specific session change must be authorized')
    if action == 'rename':
        if not isinstance(value, str) or not value.strip() or len(value) > 256 or any(ord(c) < 32 for c in value):
            raise ValueError('title must be nonempty, at most 256 characters, and single-line')
        method, field = 'rename_session', 'custom_title'
    elif action == 'tag':
        if value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 128 or any(ord(c) < 32 for c in value)):
            raise ValueError('tag must be None or a nonempty single-line string of at most 128 characters')
        method, field = 'tag_session', 'tag'
    else:
        raise ValueError('unsupported session update')
    sdk = _sdk() if sdk is None else sdk
    _sdk_verified_session(project, sid, sdk)
    operation = getattr(sdk, method, None)
    if not callable(operation):
        raise ClaudeSessionError('Claude Agent SDK session operation is unavailable')
    try:
        operation(sid, value, directory=project)
        verified = _sdk_verified_session(project, sid, sdk)
    except Exception:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Update may have occurred; inspect before retrying.'}
    if _field(verified, field) != value:
        return {'session_id': sid, 'state': 'unknown', 'note': 'Update not confirmed; inspect before retrying.'}
    return {'session_id': sid, 'state': 'updated', 'note': 'SDK metadata confirms the requested change.'}


def rename_session(project_dir: str, session_id: str, title: str, *, authorized: bool = False, sdk=None) -> dict[str, Any]:
    """Rename an explicitly authorized, project-matched session using the SDK."""
    return _organize(project_dir, session_id, title, action='rename', authorized=authorized, sdk=sdk)


def tag_session(project_dir: str, session_id: str, tag: str | None, *, authorized: bool = False, sdk=None) -> dict[str, Any]:
    """Set or clear the single Claude session tag using the SDK."""
    return _organize(project_dir, session_id, tag, action='tag', authorized=authorized, sdk=sdk)


def read_session_summary(project_dir: str, session_id: str, *, authorized: bool = False,
                         sdk=None, max_chars: int = 2000) -> dict[str, Any]:
    """Read bounded session metadata after explicit, project-scoped authorization.

    The official SDK may read parts of the underlying session record internally.
    This function never returns prompts or full transcripts. Returned summaries,
    titles and tags can still contain private data; redaction is best effort.
    """
    project, sid = _project(project_dir), _uuid(session_id)
    if authorized is not True:
        raise PermissionError('reading this specific session summary must be authorized')
    _outcome_limit(max_chars)
    sdk = _sdk() if sdk is None else sdk
    row = _sdk_verified_session(project, sid, sdk)
    def safe_text(value: Any, limit: int):
        return _redact_common_secrets(value)[:limit] if isinstance(value, str) else None
    modified = _field(row, 'last_modified')
    if isinstance(modified, bool) or not isinstance(modified, (int, float)) or not math.isfinite(modified) or modified < 0:
        modified = None
    return {'session_id': sid,
            'summary': safe_text(_field(row, 'summary'), max_chars),
            'title': safe_text(_field(row, 'custom_title'), min(max_chars, 256)),
            'tag': safe_text(_field(row, 'tag'), min(max_chars, 128)),
            'last_modified_ms': modified,
            'note': 'Authorized metadata may contain private data; credential masking is best effort.'}
