# Codex wake scheduler adapter contract

`wake_scheduler.py` is a durable scheduling component for a verified temporary Codex rate limit. It is not itself a Codex dispatcher and does not install a service. It stores a project path, session and turn identifiers, timing, state, and a lease in SQLite; it never stores prompts, transcripts, credentials, or model output. Restrict access to the database because those identifiers and paths can still be sensitive.

## Interface

- `WakeScheduler(database_path)` creates/opens a persistent SQLite database. A disk file is required.
- `schedule(job_id, project=..., session_id=..., failed_turn_id=..., reset_at=..., deadline=..., evidence=..., authorized=True, now=...)` registers a unique interrupted turn. The evidence must be a matching terminal host observation of a temporary rate limit. The caller must verify the observation and specific authorization; a dictionary is not proof.
- `step(host, clock=..., lease_seconds=...)` processes at most one due job. `status(job_id)` and `list_jobs()` show metadata; `cancel(job_id)` cancels a waiting job or marks an in-flight cancellation uncertain. `next_wake(now=...)` provides the next timestamp, and `recheck(job_id, now=...)` is for a host state-change event, not a busy polling loop.
- `serve(host, stop_event=..., changed_event=..., clock=...)` waits on an event or timestamp without model calls. It is a process loop, not a registered startup service; process shutdown and machine sleep can delay or stop it. It does not by itself wake a stopped supervisor.

A trusted, separately implemented host must expose:

1. `capabilities()` returns `backend='codex'` and true values for `atomic_conditional_dispatch`, `deduplicated_dispatch`, and `cancel_fencing` **only when the host actually enforces those guarantees**. These fields are not security credentials; never set them merely because the caller wants a retry.
2. `inspect(job)` returns authoritative session/project identity, `authorized`, `account_match`, `session_status`, `last_turn_id`, `last_turn_result`, `approval_pending`, `queued_input`, `goal_state`, `limit_active`, and `reset_at`. Unknown or mismatched state blocks dispatch. A later reset moves the wake time forward.
3. `dispatch_if_idle(job)` atomically repeats all the guard checks at the host, including authorization, account, rate limit, target session and turn, current input/approval/goal, deadline, cancellation fencing, and deduplication by job ID. It returns `{'status':'accepted','turn_id':...}` only on confirmed acceptance, or `{'status':'not_dispatched'}` only on confirmed no-op. Any other result or exception becomes `unknown` and is never replayed automatically. Acceptance does not mean the task completed.

An independent app-server reporting `notLoaded` does not prove the desktop is idle, and `turn/start` can add input to an active turn. The installed Codex host has not demonstrated the required atomic dispatch and cancellation-fencing capabilities. It must report unsupported; this module must not be presented as working automatic Codex wakeup until a real host adapter implements the contract and passes a real session test. Exclusive ownership claimed by a caller is not proof that another app or user cannot intervene.

Blocked jobs stay blocked until an external state-change event calls `recheck`. In-flight leases that expire become `unknown`; they are not replayed. Waiting uses no model inference, but a successfully resumed model turn consumes tokens. Claude Code is outside this scheduler and retains its native rate-limit behavior.
