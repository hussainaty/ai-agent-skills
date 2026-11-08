"""Project-scoped Codex metadata and conservative rate-limit wake assessment.

This adapter performs read-only discovery.  It does not send prompts, create
sessions, consume usage resets, or claim that an independent app-server can
atomically reserve a desktop chat. A host-integrated dispatcher is required.
"""
from __future__ import annotations

import math
from typing import Any

from codex_session_metadata import list_project_sessions, _validate_directory
from codex_session_status import read_project_session
from codex_goal_status import read_project_goal
from codex_account_limits import read_limits


def _timestamp(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'{name} must be a nonnegative finite timestamp')
    return float(value)


def wake_decision(*, now: float, reset_at: float | None,
                  temporary_limit_confirmed: bool, terminal_turn_confirmed: bool,
                  wake_delivery_state: str | None, user_authorized: bool,
                  account_limit_cleared: bool | None,
                  desktop_state: str | None, goal_state: str | None,
                  approval_pending: bool | None, queued_input: bool | None,
                  atomic_host_available: bool = False) -> dict[str, Any]:
    """Assess a single wake opportunity; never submit or authorize a turn.

    Booleans and states are supplied by the integrating host and are not proof.
    Any condition the host cannot actually establish must be None/unknown.
    A terminal rate-limited turn may have made changes; a new continuation must
    inspect existing work rather than replay the original request. No result from
    this assessment makes an independent app-server safe to dispatch. A host must
    enforce all checks and deduplication atomically at delivery time.
    """
    now = _timestamp(now, 'now')
    for value, field in ((temporary_limit_confirmed, 'temporary_limit_confirmed'),
                         (terminal_turn_confirmed, 'terminal_turn_confirmed'),
                         (user_authorized, 'user_authorized'),
                         (atomic_host_available, 'atomic_host_available')):
        if type(value) is not bool:
            raise TypeError(f'{field} must be boolean')
    for value, field in ((account_limit_cleared, 'account_limit_cleared'),
                         (approval_pending, 'approval_pending'),
                         (queued_input, 'queued_input')):
        if value is not None and type(value) is not bool:
            raise TypeError(f'{field} must be boolean or None')
    if not user_authorized:
        return {'action': 'stop', 'reason': 'per-session authorization missing'}
    if not temporary_limit_confirmed:
        return {'action': 'stop', 'reason': 'temporary rate limit not established'}
    if not terminal_turn_confirmed:
        return {'action': 'hold', 'reason': 'previous turn is not confirmed terminal'}
    if wake_delivery_state == 'accepted':
        return {'action': 'stop', 'reason': 'continuation already accepted; do not send again'}
    if wake_delivery_state not in ('not_sent', 'confirmed_not_accepted'):
        return {'action': 'hold', 'reason': 'continuation delivery is in flight or unknown; reconcile before retry'}
    if reset_at is None:
        return {'action': 'stop', 'reason': 'reset time unknown'}
    reset = _timestamp(reset_at, 'reset_at')
    if now < reset:
        return {'action': 'wait', 'retry_at': reset, 'reason': 'provider reset not reached'}
    if account_limit_cleared is not True:
        return {'action': 'hold', 'reason': 'account limit remains or is unknown'}
    if desktop_state != 'idle':
        return {'action': 'hold', 'reason': 'desktop-wide idle state is not confirmed'}
    if goal_state not in ('active', 'none'):
        return {'action': 'hold', 'reason': 'goal is paused, limited, blocked or unknown'}
    if approval_pending is not False or queued_input is not False:
        return {'action': 'hold', 'reason': 'pending approval or user input is present or unknown'}
    if not atomic_host_available:
        return {'action': 'hold', 'reason': 'no supported atomic host dispatch'}
    return {'action': 'host_handoff_only', 'reason': 'host must atomically recheck and deduplicate before accepting; this adapter never sends'}


class CodexAdapter:
    """Scoped local app-server reader; native desktop host tools take priority."""
    def __init__(self, directory: str, *, command: Any = None, timeout: float = 30):
        self.directory = _validate_directory(directory)
        self.command = command
        self.timeout = timeout

    def list_sessions(self, limit: int = 10) -> dict[str, Any]:
        return list_project_sessions(self.directory, limit=limit, command=self.command, timeout=self.timeout)

    def session_status(self, session_id: str) -> dict[str, Any]:
        return read_project_session(self.directory, session_id, command=self.command, timeout=self.timeout)

    def session_outcome(self, session_id: str, *, authorized: bool = False, max_chars: int = 4000) -> dict[str, Any]:
        """Return bounded latest assistant text only with explicit caller authorization.

        The caller is responsible for verifying its user granted this access;
        a boolean is not an authentication or authorization mechanism.
        """
        if authorized is not True:
            raise PermissionError('specific session outcome authorization required')
        return read_project_session(self.directory, session_id, command=self.command, timeout=self.timeout,
                                    _include_outcome=True, _max_chars=max_chars)

    def goal_status(self, session_id: str) -> dict[str, Any]:
        return read_project_goal(self.directory, session_id, command=self.command, timeout=self.timeout)

    def rate_limits(self) -> dict[str, Any]:
        return read_limits(command=self.command, timeout=self.timeout)

    def wake_decision(self, **kwargs: Any) -> dict[str, Any]:
        return wake_decision(**kwargs)
