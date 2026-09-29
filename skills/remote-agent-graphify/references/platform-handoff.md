# Platform handoff notes

Use this reference only when connecting the skill to a particular platform.

## Coder

Coder scans its workspace working directory and `~/.coder` for skills. Within a
scan root, it recognizes immediate children of `skills/`, `.agents/skills/`,
`.claude/skills/`, and `.codex/skills/`. It captures a context snapshot for a
chat, so a newly added or changed skill becomes available to an existing chat
after a context refresh. Keep `SKILL.md` below Coder's 64 KiB limit.

Coder template lifecycle scripts can install dependencies or clone repositories,
but they should be changed only when the user asks to alter the template. An
on-demand Graphify build avoids startup cost and only needs the project
repository, a Graphify runtime, and persistent storage for `graphify-out/`.

## Claude Code

Claude Code recognizes project skills at `.claude/skills/<name>/SKILL.md` and
personal skills at `~/.claude/skills/<name>/SKILL.md`. Keep the same skill
folder name and frontmatter in both locations. Project skills travel with the
repository; personal skills are available across the user's projects. Use the
project copy as the shared source of team behavior, and avoid overwriting an
existing personal skill without comparing it first.

## TrueForge

TrueForge supports Git-backed `SKILL.md` instruction packs that are mounted into
the sandbox on demand. Register this directory from a Git repository and give
the agent access to the checked-out project plus either the Graphify runtime or
an approved Graphify MCP tool. Keep model credentials, connector credentials,
and approval policy in TrueForge rather than in this skill or the graph output.

## Shared deployment check

Before the first agent run, verify that the sandbox or workspace can read the
repository, Graphify can write `<repo>/graphify-out/`, and that the graph output
survives for as long as subsequent runs are expected to reuse it. For an
ephemeral TrueForge sandbox, rebuild or update from the checked-out revision at
the start of a run instead of assuming a previous session's files remain.
