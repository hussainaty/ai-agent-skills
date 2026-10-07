---
name: session-wrap-up
description: Writes a dated end-of-session summary of decisions, outcomes, open threads, and links between tasks into one memory folder with one index, and reads back only the relevant entries at the start of the next session. Use when the user says "wrap up", "save this session", "end of session", "remember what we did", or is about to close or switch sessions, accounts, or agents; and at session start when continuing earlier work.
metadata:
  short-description: Save decisions (not dialogue) per session; read back what is relevant
---

# Session Wrap-Up

Agents start every conversation from zero. Re-pasting background costs
tokens and loses detail. At the end of a **session**, write a short,
structured record of what was decided and what is still open. At the start of
the next session, read back only the entries that matter.

Credit: the pattern comes from a reel by nocodealex (2026-08-04,
https://www.instagram.com/reel/Dbm200gvDsG/). It fits the episodic and
semantic layers of the engineering workflow's memory rules.

## Storage: one folder, one index

- Folder: `<memory root>/sessions/`. The default memory root is the
  device's global memory map when one exists (for example
  `~/Documents/Codex/global memory`); otherwise `~/.agent-memory`.
- One file per session, with the date in the name:
  `YYYY-MM-DD-<agent>-<short-topic>.md`. Never append to one growing file.
  A bad session can then be deleted without unpicking it from the others.
- One index: `sessions/INDEX.md`. Each entry is a single line: date, agent,
  project, topic, link, and 3–6 keywords.
- The folder is plain Markdown, so it can be synced to Google Drive and added
  to a NotebookLM notebook as a source. NotebookLM has no public write API:
  adding the folder is a one-time manual step (Drive sync or an upload), not
  something to automate or promise.

## Wrap up (end of session)

1. Collect from this session only: decisions and their reasons, what was
   built or changed (paths, commits, links), verified results, failures and
   their fixes, open questions, and the next actions.
2. Write the file from the template below. **Save decisions, not
   dialogue.** No transcript, no pasted logs. Keep it under about 60 lines.
3. Record **connections between tasks**: which task's output feeds another,
   shared decisions, and contradictions with earlier sessions. These links are
   the most valuable part of the record, and they are why wrap-up happens per
   session rather than per task.
4. Add one line to `INDEX.md`.
5. If a lesson recurs (it is already in an earlier session file), promote it
   to a procedural rule (a skill, CLAUDE.md/AGENTS.md, or a hook) and say so.
6. Tell the user the file path in one line.

## Read back (start of session)

1. Read `INDEX.md` only.
2. Pick the entries that match the current project, topic, or keywords
   (usually 1–3), and read those files. Do not load the whole folder.
3. Treat the content as leads: verify file paths, versions, and states
   against the current code before acting on them.

## Never store

Secrets, tokens, passwords, API keys, client personal data (phones, emails,
IDs), or account-owned transcripts. Record where a secret lives, never its
value. Keep client names out unless the memory root is private to the user,
and even then only as needed.

## Template

```markdown
# <YYYY-MM-DD> — <agent> — <project>: <topic>

## Decisions
- <decision> — because <reason>. (who decided)

## Done
- <change> — <path/commit/link> — verified by <test/command/screenshot>

## Failures and fixes
- <symptom> -> <verified cause> -> <fix>

## Connections
- <task A> feeds <task B> because <...>
- Contradicts/updates <earlier session file>: <what changed>

## Open
- <question or blocker> — waiting on <whom>

## Next
- <first action next session>
```

Index line format:

```markdown
- 2026-10-08 · claude-code · ai-skills · engineering workflow + public repo · [file](2026-10-08-claude-code-workflow.md) · workflow, jury, memory, publish
```
