# Memory rules

How the workflow reads and writes long-term memory. Based on the short
"Agent Memory Types Explained: Working, Semantic, Episodic & Procedural"
(Nerdy Engineering Stuff, 2026-10-05,
https://www.youtube.com/shorts/uigDgbqCa7I). Its sources are CoALA,
LangChain's memory concepts, LangGraph persistence and stores, and Reflexion.
The rules were taken from the video's own description, fetched with Agent
Reach (yt-dlp) on 2026-10-08. Captions were rate-limited at the time.

## Contents

- First split: persistence vs purpose
- The four memory types
- Where each type lives
- Read rules
- Write rules

## First split: persistence vs purpose

Ask two separate questions about any piece of information:
1. **How long** must it stay available: this step, this task, or across tasks?
2. **What job** does it do: state, fact, experience, or procedure?

Storage (files, SQL, a graph, vector search) and retrieval (exact lookup,
keyword, semantic search) are separate choices from the type. "Semantic
memory" (facts) is not the same thing as "semantic search" (a retrieval
method). Retrieving saved text puts it in context; it does not change the
model.

## The four memory types

| Type | Holds | Example | Caution |
|---|---|---|---|
| Working | The current task's state: goal, messages, tool results | `workflow/STATE.md`, the open plan | Checkpoint it; summarize to fit the context window |
| Semantic | Facts and preferences | "the project uses pnpm", "the operator wants approval before any push" | Can go stale; re-verify facts about code |
| Episodic | Experiences: what happened and what fixed it | "deploy timed out; raising the health-check start period fixed it" | A past fix is a case to examine, not proof of the current cause |
| Procedural | How-to: instructions, skills, workflows | this skill; project CLAUDE.md/AGENTS.md rules | A check that must always run belongs in code (a hook, CI, a test), not only in prose |

## Where each type lives

| Type | Store |
|---|---|
| Working | `workflow/STATE.md` in the project (resume point); session context |
| Semantic | Agent memory files (one fact per file, with an index); the global memory map's `MEMORY.md` |
| Episodic | One dated file per session in `sessions/` with `sessions/INDEX.md` (`session-wrap-up`); the claude-mem observation log when installed |
| Procedural | Skills, `CLAUDE.md` / `AGENTS.md`; hooks via `hooks-create`; tests |

Scope every record. Keep user-level facts in the user scope and project facts
in that project's scope. Never mix one client's data into another's project.

## Read rules (Phase 0)

1. Read the procedural layer first (project rules, this workflow).
2. Read semantic memory for the operator and the project.
3. Search episodic memory for the same component, error message, or task
   type. Use a hit as a hypothesis to test.
4. Verify any remembered claim about files, functions, or flags against the
   current code before acting on it.

## Write rules (Phase 9, and whenever something notable happens)

- **Start from a real failure.** Add memory that would have prevented an
  actual mistake or saved real time. Do not log everything.
- **Provenance and date** on every entry: what, when (absolute date), source
  (task, commit, conversation), and confidence.
- **Revise, don't duplicate.** Update or delete a stale entry instead of
  appending a contradicting one.
- **Promote repeat lessons.** An episode that recurs becomes a procedural
  rule. If the rule must never be skipped, enforce it with a hook or test.
- **Never store** secrets, tokens, passwords, or client personal data
  (phones, emails, IDs) in memory. Store where they live, not their values.
- Account-owned transcripts and app databases are not copied into memory.
  Record metadata and decisions only.

## Entry templates

```markdown
## 2026-10-08 — semantic — <project or "user">
<fact or preference>. Source: <task/commit/conversation>. Confidence: high.

## 2026-10-08 — episode — <project>
Symptom: <what failed>. Cause: <verified cause>. Fix: <what changed>.
Evidence: <commit/test>. Watch for: <signal that it is happening again>.

## 2026-10-08 — procedure — <scope>
Rule: <do X when Y>. Why: <failure it prevents>. Enforced by: <hook/test/none>.
```
