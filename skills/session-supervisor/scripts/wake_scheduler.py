"""Durable, host-gated Codex rate-limit continuation scheduling.

This module stores only identifiers and timing, never prompts or transcripts.
It does NOT provide an actual Codex dispatcher: an independently implemented
host must provide atomic conditional dispatch and deduplication. Current Codex
app-server APIs have not been shown to provide these guarantees.
"""
from __future__ import annotations

from contextlib import contextmanager
import math
import os
import sqlite3
import time
import uuid
from typing import Any


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(name + ' must be a finite number')
    return float(value)


def _identifier(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError(name + ' must be a bounded non-empty string')
    return value


class WakeScheduler:
    """Persist wake intents and require an authoritative atomic host to dispatch."""

    def __init__(self, db_path: os.PathLike | str):
        self.db_path = os.fspath(db_path)
        if self.db_path == ':memory:':
            raise ValueError('a durable database path is required')
        with self._connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS wake_jobs (
                id TEXT PRIMARY KEY,
                project TEXT NOT NULL,
                session_id TEXT NOT NULL,
                failed_turn_id TEXT NOT NULL,
                reset_at REAL NOT NULL,
                deadline REAL NOT NULL,
                state TEXT NOT NULL,
                reason TEXT,
                lease TEXT,
                lease_until REAL,
                accepted_turn_id TEXT,
                UNIQUE(project, session_id, failed_turn_id)
            )''')

    @contextmanager
    def _connect(self):
        db = sqlite3.connect(self.db_path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def schedule(self, job_id: str, *, project: str, session_id: str,
                 failed_turn_id: str, reset_at: float, deadline: float,
                 evidence: dict, authorized: bool, now: float) -> dict:
        """Record a specifically authorized, confirmed temporary limit.

        Evidence must be a terminal host observation, not a generic 429, model
        claim, or user-supplied guess. The caller is responsible for verifying
        its source; these fields alone do not grant authority.
        """
        job_id = _identifier(job_id, 'job_id')
        session_id = _identifier(session_id, 'session_id')
        failed_turn_id = _identifier(failed_turn_id, 'failed_turn_id')
        project = os.fspath(project)
        if not isinstance(project, str) or not os.path.isabs(project) or not os.path.isdir(project):
            raise ValueError('project must be an existing absolute directory')
        project = os.path.normcase(os.path.normpath(project))
        now, reset_at, deadline = (_number(now, 'now'), _number(reset_at, 'reset_at'),
                                   _number(deadline, 'deadline'))
        if deadline <= max(now, reset_at):
            raise ValueError('deadline must be after reset and current time')
        if authorized is not True:
            raise PermissionError('explicit per-session authorization is required')
        if (not isinstance(evidence, dict) or evidence.get('source') != 'host' or
                evidence.get('kind') != 'temporary_rate_limit' or evidence.get('terminal') is not True or
                evidence.get('turn_id') != failed_turn_id):
            raise ValueError('a matching terminal host rate-limit observation is required')
        try:
            with self._connect() as db:
                db.execute('INSERT INTO wake_jobs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)',
                           (job_id, project, session_id, failed_turn_id, max(now, reset_at), deadline, 'pending'))
        except sqlite3.IntegrityError:
            raise ValueError('wake job or interrupted turn is already registered') from None
        return self.status(job_id)

    def status(self, job_id: str) -> dict:
        with self._connect() as db:
            row = db.execute('SELECT * FROM wake_jobs WHERE id=?', (_identifier(job_id, 'job_id'),)).fetchone()
        if row is None:
            raise ValueError('unknown wake job')
        return dict(row)

    def list_jobs(self) -> list[dict]:
        """Return metadata only, never prompts or model content."""
        with self._connect() as db:
            return [dict(row) for row in db.execute('SELECT * FROM wake_jobs ORDER BY reset_at, id')]

    def cancel(self, job_id: str) -> dict:
        job_id = _identifier(job_id, 'job_id')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state FROM wake_jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise ValueError('unknown wake job')
            if row['state'] in ('pending', 'blocked'):
                db.execute("UPDATE wake_jobs SET state='cancelled', reason='cancelled' WHERE id=?", (job_id,))
            elif row['state'] == 'dispatching':
                db.execute("UPDATE wake_jobs SET state='cancel_requested', reason='dispatch outcome not yet known' WHERE id=?", (job_id,))
        return self.status(job_id)

    def recheck(self, job_id: str, *, now: float) -> dict:
        """Wake a blocked job only after the caller receives a host state change."""
        job_id, now = _identifier(job_id, 'job_id'), _number(now, 'now')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state, deadline, reset_at FROM wake_jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                raise ValueError('unknown wake job')
            if row['state'] != 'blocked':
                raise ValueError('only a blocked wake job can be rechecked')
            state = 'pending' if now < row['deadline'] else 'stopped'
            db.execute('UPDATE wake_jobs SET state=?, reason=NULL, reset_at=? WHERE id=?',
                       (state, max(now, row['reset_at']), job_id))
        return self.status(job_id)

    def recover_expired(self, *, now: float) -> int:
        now = _number(now, 'now')
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            cursor = db.execute("UPDATE wake_jobs SET state='unknown', reason='expired in-flight lease', lease=NULL, lease_until=NULL WHERE state IN ('dispatching','cancel_requested') AND lease_until<=?", (now,))
            db.execute("UPDATE wake_jobs SET state='stopped', reason='deadline reached' WHERE state='pending' AND deadline<=?", (now,))
            return cursor.rowcount

    def next_wake(self, *, now: float) -> float | None:
        """Return the next timestamp needing attention; blocked jobs never spin."""
        now = _number(now, 'now')
        with self._connect() as db:
            row = db.execute("SELECT MIN(at) AS next FROM (SELECT reset_at AS at FROM wake_jobs WHERE state='pending' UNION ALL SELECT lease_until AS at FROM wake_jobs WHERE state IN ('dispatching','cancel_requested'))").fetchone()
        return None if row['next'] is None else max(now, row['next'])

    def _claim(self, now: float, lease_seconds: float) -> dict | None:
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute("SELECT * FROM wake_jobs WHERE state='pending' AND reset_at<=? AND deadline>? ORDER BY reset_at,id LIMIT 1", (now, now)).fetchone()
            if row is None:
                return None
            lease = uuid.uuid4().hex
            db.execute("UPDATE wake_jobs SET state='dispatching', lease=?, lease_until=? WHERE id=?", (lease, now+lease_seconds, row['id']))
            value = dict(row)
            value['lease'] = lease
            value['lease_until'] = now + lease_seconds
            return value

    def _finish(self, job: dict, *, state: str, reason: str, now: float,
                reset_at: float | None = None, accepted_turn_id: str | None = None,
                safe_not_dispatched: bool = False) -> dict:
        with self._connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT state, lease, lease_until FROM wake_jobs WHERE id=?', (job['id'],)).fetchone()
            if row is None:
                raise ValueError('unknown wake job')
            if row['lease'] != job['lease'] or row['state'] not in ('dispatching', 'cancel_requested'):
                return dict(db.execute('SELECT * FROM wake_jobs WHERE id=?', (job['id'],)).fetchone())
            if row['lease_until'] <= now:
                state, reason, accepted_turn_id = 'unknown', 'expired in-flight lease', None
            elif row['state'] == 'cancel_requested':
                if safe_not_dispatched:
                    state, reason, accepted_turn_id = 'cancelled', 'cancelled before dispatch', None
                else:
                    # A concurrent cancellation cannot prove a host call did not start.
                    state, reason, accepted_turn_id = 'unknown', 'cancel requested during dispatch', None
            if reset_at is None:
                reset_at = job['reset_at']
            db.execute('UPDATE wake_jobs SET state=?, reason=?, reset_at=?, lease=NULL, lease_until=NULL, accepted_turn_id=? WHERE id=?',
                       (state, reason, reset_at, accepted_turn_id, job['id']))
            return dict(db.execute('SELECT * FROM wake_jobs WHERE id=?', (job['id'],)).fetchone())

    def step(self, host: Any, *, clock=time.time, lease_seconds: float = 30) -> dict | None:
        """Process one due job. A returned `accepted` is not completed work.

        `host.capabilities()` must attest real host-enforced conditional dispatch
        deduplication and cancel fencing. `inspect(job)` must provide authoritative
        status. `dispatch_if_idle(job)` must atomically recheck all conditions
        at the host, including cancellation, and deduplicate by job['id'];
        caller assertions are not enough.
        """
        if not callable(clock):
            raise TypeError('clock must be callable')
        lease_seconds = _number(lease_seconds, 'lease_seconds')
        if lease_seconds <= 0:
            raise ValueError('lease_seconds must be positive')
        now = _number(clock(), 'clock')
        self.recover_expired(now=now)
        job = self._claim(now, lease_seconds)
        if job is None:
            return None
        def finish(state, reason, **kwargs):
            return self._finish(job, state=state, reason=reason, now=_number(clock(), 'clock'), **kwargs)
        try:
            capabilities = host.capabilities()
            if (not isinstance(capabilities, dict) or capabilities.get('backend') != 'codex' or
                    capabilities.get('atomic_conditional_dispatch') is not True or
                    capabilities.get('deduplicated_dispatch') is not True or capabilities.get('cancel_fencing') is not True):
                return finish('blocked', 'host lacks verified atomic conditional dispatch')
            view = host.inspect(dict(job))
            if not isinstance(view, dict):
                return finish('blocked', 'host state unavailable')
            if (view.get('authorized') is not True or view.get('account_match') is not True or
                    view.get('session_id') != job['session_id'] or view.get('project') != job['project'] or
                    view.get('session_status') != 'idle' or view.get('last_turn_id') != job['failed_turn_id'] or
                    view.get('last_turn_result') != 'temporary_rate_limit' or
                    view.get('approval_pending') is not False or view.get('queued_input') is not False or
                    view.get('goal_state') not in ('active', 'none')):
                return finish('blocked', 'session or authorization state prevents wake')
            reset_at = _number(view.get('reset_at'), 'host reset_at')
            current = _number(clock(), 'clock')
            if view.get('limit_active') is True and reset_at > current:
                if reset_at >= job['deadline']:
                    return finish('stopped', 'reset exceeds deadline')
                return finish('pending', 'host extended reset', reset_at=reset_at)
            if view.get('limit_active') is not False or reset_at > current:
                return finish('blocked', 'limit availability is not confirmed')
            if current >= job['deadline']:
                return finish('stopped', 'deadline reached before dispatch', safe_not_dispatched=True)
            if current >= job['lease_until']:
                return finish('unknown', 'lease expired before dispatch', safe_not_dispatched=True)
            with self._connect() as db:
                row = db.execute('SELECT state, lease FROM wake_jobs WHERE id=?', (job['id'],)).fetchone()
            if row is None or row['state'] != 'dispatching' or row['lease'] != job['lease']:
                return finish('blocked', 'cancelled before dispatch', safe_not_dispatched=True)
            # The host must repeat *every* authorization, state, timing and
            # deduplication condition atomically; inspect() is only advisory.
            response = host.dispatch_if_idle(dict(job))
            if not isinstance(response, dict):
                return finish('unknown', 'host acceptance unknown')
            if response.get('status') == 'accepted':
                turn_id = response.get('turn_id')
                if not isinstance(turn_id, str) or not turn_id.strip():
                    return finish('unknown', 'accepted response missing turn id')
                return finish('accepted', 'host accepted continuation; completion unverified', accepted_turn_id=turn_id)
            if response.get('status') == 'not_dispatched':
                return finish('blocked', 'host declined conditional dispatch')
            return finish('unknown', 'host acceptance unknown')
        except Exception:
            # Before dispatch the conservative outcome could be blocked; after
            # dispatch an exception may hide acceptance. Never replay either.
            return finish('unknown', 'host error or acceptance unknown')

    def serve(self, host: Any, *, stop_event: Any, changed_event: Any, clock=time.time,
              max_idle_seconds: float = 60, lease_seconds: float = 30) -> None:
        """Run while requested; wait on a timer/event with no model inference.

        A finite idle wait also notices database changes made by other processes.
        No scheduler is installed automatically and OS sleep may delay wakeup.
        """
        max_idle_seconds = _number(max_idle_seconds, 'max_idle_seconds')
        if max_idle_seconds <= 0:
            raise ValueError('max_idle_seconds must be positive')
        while not stop_event.is_set():
            while not stop_event.is_set() and self.step(host, clock=clock, lease_seconds=lease_seconds) is not None:
                pass
            wake_at = self.next_wake(now=clock())
            delay = max_idle_seconds if wake_at is None else min(max_idle_seconds, max(0, wake_at-clock()))
            # Events should be set by a same-process caller after schedule/recheck.
            changed_event.wait(timeout=delay)
            changed_event.clear()
