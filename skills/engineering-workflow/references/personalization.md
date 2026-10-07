# Personalization: the operator profile

The workflow adapts to the person running it through an **operator
profile**: a semantic-memory record of their standing preferences. The
profile is private. It lives in the user's own memory store (for example
`~/.claude/projects/<project>/memory/` or a global memory map), never in a
shared repository.

## Building the profile

Derive it from evidence, not guesses:
1. The user's agent instructions (`CLAUDE.md`, `AGENTS.md`).
2. Their past prompts. Look for repeated corrections ("don't push yet",
   "don't buy anything", "show me the app running"); those are the strongest
   signals.
3. Their memory stores (global memory map, agent memory).

Record each preference with its source and date (see
[memory-rules.md](memory-rules.md)). Ask the human to confirm the profile once,
then keep it current.

## Profile template

Copy [../templates/operator-profile.md](../templates/operator-profile.md) into
the private memory store and fill it in.

## Defaults this workflow applies when no profile exists

These come from patterns common in agent-driven delivery work. A profile
overrides them.

- **Blueprint before code.** Research and plan first; wait for "go" before
  implementing.
- **Gate outward actions.** Pushing to a shared branch, deploying, sending
  email or invitations, buying anything, and creating accounts each need an
  explicit go-ahead at that moment.
- **Secrets stay hidden.** Point to the file that holds a secret; never print
  its value.
- **Resume, don't restart.** Continue from the exact working tree. Never revert
  work that was already accepted. After a session limit, pick up from
  `STATE.md`.
- **Demo-ready by default.** Sensible default settings so the app runs
  without setup; seed data that exercises every feature; show it running.
- **Match visual references exactly.** When the human sends a screenshot or
  reference image, match its geometry and layout, and verify with your own
  screenshot side by side.
- **Stay in scope.** Do not add powers, roles, or features the human did not
  ask for. The mandate is the request, nothing more.
- **Bilingual products.** When the profile lists more than one language,
  every UI change is checked in each language, including RTL layout.
