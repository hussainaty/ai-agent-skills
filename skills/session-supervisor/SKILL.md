---
name: session-supervisor
description: Manage related coding-agent sessions from one supervisor, delegate implementation and testing to suitable workers, and review their results.
---

# Session Supervisor

Coordinate the user's task from one higher-level session. Keep the user's normal workflow, project boundaries and permissions intact.

## Choose and retain sessions

1. Discover the actual Codex, Claude Code, OpenCode and Hermes tools and models available on this host. Verify authentication, current pricing, tool access and suitability for the particular job; a free or large model is not automatically a good worker. Prefer OpenCode for suitable normal implementation and use Hermes or another available model for assistance or review when it fits. Do not silently switch to a paid route.
2. Find the relevant project and existing session using supported host tools and authorized metadata. Choose based on actual task context, not assumed access. Create a new user-visible Codex chat only when the user explicitly requests one; use available internal worker sessions for subtasks within host rules.
3. Keep the same worker session open and reuse its ID for all related tasks, fixes and follow-up reviews so it retains useful context. Do not close it merely because a task iteration finished. Start a separate session for an unrelated project or substantially unrelated context. Preserve IDs, project scope and state across handoffs; if a session is unavailable, say so rather than inventing continuity.

## Delegate the work, then review

- Group related implementation tasks, fixes and tests into one coherent work package. The supervisor writes one comprehensive, bounded brief with the goal, ordered plan, relevant context and file paths, permitted write scope, acceptance criteria, tests and commands where known, constraints, budget and stop conditions. Include enough detail for the worker to make routine decisions and finish independently; omit irrelevant transcripts and do not pad the prompt merely to make it long.
- Send the package in one worker dispatch, including when using DeepSeek through OpenCode. Instruct the worker to implement all related items, run the relevant tests, diagnose and repair failures, and repeat until the work meets the acceptance criteria or it reaches a genuine blocker. Do not split a cohesive package into many small sequential requests or ask for approval on routine in-scope decisions.
- Ask the worker to implement, run the specified tests, inspect failures, fix its work, and run the relevant tests again. Let it repeat that cycle while it is making meaningful progress. On a blocker, repeated failure, missing permission or uncertain result, keep the session and escalate the evidence rather than spinning or pretending it passed.
- Wait for completion or a genuine blocker before reviewing. Prefer a completion notification or the longest practical blocking wait offered by the tool; if polling is necessary, use infrequent, bounded, compact status checks without additional model prompts. A wait timeout is not completion or cancellation: continue waiting on the same job, not dispatching a duplicate. Respond promptly to permission requests and real blockers. Request one compact final result: changed files, commands and actual test results, remaining issues and questions. Do not repeatedly retrieve full transcripts.
- The higher-level model independently inspects the result and relevant diff/evidence, reviews architecture and edge cases, and runs or requests proportionate independent checks. If it finds a missed issue, refine the plan and send the correction back to the same related worker session. The supervisor, not the worker's self-report, decides acceptance.
- If a nonblocking problem in this skill is discovered, record it, finish the user's main task, then fix and verify the skill within the user's authorization. If the problem blocks safe or correct work, report it and address it before continuing.

## Rate limits and token use

- For Codex, do not send a wake-up to a working session. Only a confirmed temporary rate-limit stop is eligible after reset; never override a pause, budget stop, pending approval or queued user input. The included queue is a component, not an active desktop wakeup: it needs a host that can atomically check eligibility and deduplicate delivery. Unknown acceptance is not replayed. Do not claim automatic wakeup when the host cannot provide it.
- Leave Claude Code's own rate-limit handling intact. Do not add a duplicate retry loop. Waiting and status checks should avoid inference; resumed work consumes tokens.
- When an observable limit, requested handoff, or interruption threatens unfinished work, checkpoint the existing notebook and prepare a private Codex/Claude handoff using [continuity](references/continuity.md). Do not invent quota telemetry. When the task is registered with the [relay](references/relay.md), finish by writing its `relay-signal.json`; the relay starts the other agent automatically. Otherwise do not claim another agent will start.
- Minimize the supervisor's and workers' total context, redundant polling, retries and duplicated work while maintaining quality. Record actual usage when exposed. Delegation can increase total tokens or cost, so do not promise savings without a comparable measurement.

The optional local MCP supplies supported Codex and Claude session operations. Other worker MCPs, clients, models and credentials require their own setup. A skill alone does not install a provider, grant access or keep a stopped process alive. Read [Codex support](references/codex.md), [Claude support](references/claude.md), or [Codex wakeup](references/wakeup.md) only as needed.

