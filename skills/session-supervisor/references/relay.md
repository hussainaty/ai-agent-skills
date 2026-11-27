# Automatic Codex <-> Claude relay

`scripts/agent_relay.py` continues one task across Codex and Claude without a human. It never steers an existing interactive session, so it sidesteps the unsolved idle-only dispatch problem in [wakeup](wakeup.md): each hop is a **new headless run** (`claude -p` or `codex exec`) in the project, pointed at the task's continuation files.

## Lifecycle

1. `register --task-dir <dir> --project <repo> [--max-hops 12] [--watch-codex-limit]` adds a task. The task directory holds `AI_CONTINUATION_CONTEXT.md` and, per recipient, `CLAUDE_CONTINUATION_PROMPT.md` / `CODEX_CONTINUATION_PROMPT.md` (see [continuity](continuity.md)).
2. A run is requested by `handoff --task-dir <dir> --to claude|codex`, or automatically when `--watch-codex-limit` is set and Codex's account limit is reached while the task is idle.
3. `tick` (run every 10 minutes by a scheduler) advances each pending task by at most one run, when: not locked, hop budget left, `not_before` passed, and for Codex, the account-limit read shows no reached limit (otherwise it waits until `resetsAt`). Waiting uses no inference.
4. Before stopping, the agent updates `AI_CONTINUATION_CONTEXT.md` and writes `relay-signal.json`: `{"action":"complete"}`, `{"action":"handoff","to":"codex"}` or `{"action":"stop","reason":"..."}`. A file is used because a sandboxed Codex run could not launch the relay's Python.
5. Optional checklist `tasks.json` in the task directory: `[{"id": "login-form", "check": "npm test -- login", "passes": false}, ...]` (or `{"tasks": [...]}`). Each run works on the first item not passing and sets `"passes": true` only after its check passed; items are never deleted or reworded. An agent's `complete` signal is **refused** while any item is not passing: the run is treated as unsignalled, the reason is recorded in the history entry, and repeated refusals without progress stop the task for a human. A human's `complete` command is not gated. Why: Anthropic's long-running harness keeps an ordered feature list with pass flags in JSON so agents neither declare victory early nor rewrite the plan ([effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)), and missing or wrong verification is one of the three failure categories of multi-agent systems ([MAST, arXiv 2503.13657](https://arxiv.org/abs/2503.13657)). The file is part of the progress fingerprint.
6. Without a signal: a detected usage limit hands off to the other agent; otherwise the same agent is restarted, and after 2 runs with no change to Git HEAD/status/diff or the context files the task stops for a human. `status` shows each task; outcomes are appended to `~/.agent-relay/relay.log`; per-run token usage is kept in `relay.json` history.

## Safety boundaries

- Claude runs with `--permission-mode auto` and Codex with `-s workspace-write` and `approval_policy="never"` (writes confined to the project and task directory). Change them per task with `register --claude-permission-mode` / `--codex-sandbox`; weakening them is the user's decision.
- The prompt forbids pushing, publishing, deploying or spending unless the continuation context records that authorization.
- `relay.lock` (live-PID checked) prevents two relay runs on one task. It does not stop a human's interactive session from editing the same project at the same time; use `--watch-codex-limit` only for tasks whose interactive Codex session is the one that hit the limit.
- Claude's remaining quota is not readable; a limit is detected from the run's result and retried after 30 minutes or handed to Codex.

## Scheduler (Windows)

```
schtasks /Create /TN AgentRelay /SC MINUTE /MO 10 /F /TR "\"<venv>\Scripts\pythonw.exe\" \"<skill>\scripts\agent_relay.py\" tick"
schtasks /Delete /TN AgentRelay /F      # disconnect
```

Runs only while the user is logged on; a sleeping or shut-down machine delays hops. On a laptop, Task Scheduler's defaults skip runs on battery: register with `New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`. Check health with `Get-ScheduledTask AgentRelay` (State must be `Ready`, not `Disabled`) and `Get-ScheduledTaskInfo` (`NumberOfMissedRuns`).

## Verified (2026-11-15)

Real chains in throwaway repos: Claude -> Codex -> complete, and Codex -> Claude -> complete, two ticks each, the third tick idle. Per hop for a trivial step: Claude ~172k input (mostly cache reads), ~1k output, $0.29; Codex ~264k input (92% cached), ~4.8k output. Fixed per-hop context is large, so hops should carry substantial work, not tiny steps.

## Codex chat auto-continue

`watch-codex --thread <codex-session-id> [--project <dir>] [--claude-takeover]` watches one Codex chat (the desktop app's chats included). Each tick reads that chat's own session record under `~/.codex/sessions`. When its last turn ended with `task_complete` and `codex_error_info: "usage_limit_exceeded"`, the relay waits for the account limit to reset, then continues the **same chat** with `codex exec resume <id>`, so the continuation appears in that chat's history. Guards:

- Each limited turn is continued once (`continued_turn`); a later limit stop in the same chat is continued again.
- The chat must have been quiet for 2 minutes and its last event must be a finished turn; a running turn (`task_started` last) is never touched. This check is not atomic: someone typing into the chat at that exact moment can race it.
- `--claude-takeover` lets Claude work from the task's continuation files while Codex waits, then hands back to the chat.

Checked with real runs: `codex exec resume` delivers into the existing chat; Codex's own `codex queue` stores messages that are delivered on the next resume (`turn_trigger: "queue"`), but its `--resume` needs an app-server daemon that the app-bundled CLI cannot start.

## Claude -> Codex connector

The session-supervisor MCP exposes `codex_task_start` (needs `authorized` and `model_use_authorized`), `codex_task_wait`, `codex_task_cancel` and `codex_task_list`. Claude sends one complete work package; Codex runs as a background job (`codex exec`, or `exec resume` with `thread_id`) in a `workspace-write` or `read-only` sandbox. The job leaves the caller's Windows job object, so it survives the Claude session ending. Results include the final message, Codex chat id and token usage; review the actual diff before accepting.

Measured (2026-11-16): a one-line fix delegated to Codex took 198 s and 441k input tokens (95% cached), 1.4k output. Codex's fixed start-up context dominates, so delegate substantial packages only.

Known limit: inside Codex's Windows sandbox no Python interpreter is reachable (the user installs under `AppData` are not readable), so delegated Python test runs fail there; run those tests yourself or grant access deliberately.
