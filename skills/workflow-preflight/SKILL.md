---
name: workflow-preflight
description: "Route a substantive coding, research, cross-agent, or production request before work begins. Select the smallest compatible set of installed skills, or explicitly conclude that no specialized skill is needed; discover an online skill only for a real capability gap. Use before work that may benefit from repository context, public research, implementation, verification, or external systems. Do not use for a direct factual answer, simple calculation, or isolated rewrite."
---

# Workflow Preflight

Run this preflight before starting substantive work. Its purpose is to improve
the main task by selecting the right capabilities, not to load every available
skill or delay straightforward work with unnecessary research.

## Select skills before acting

1. Identify the outcome, target environment, data sensitivity, external
   systems, and evidence needed to call the task complete. Stop here for a
   direct answer, calculation, or isolated rewrite: no specialized skill is
   needed.
2. Make a provisional shortlist from the available-skills metadata. Prefer the
   published inventory; for a workspace, also check project roots such as
   `.agents/skills/`, `.claude/skills/`, `.opencode/skills/`, and
   `.hermes/skills/`. Limit the shortlist to the few capabilities that plausibly
   cover a material part of the task. Never select a route whose skill or
   required tool is unavailable in the current runtime.
3. Read the full instructions only for that shortlist. Select the smallest
   compatible set based on coverage, sequencing, available tools and access,
   and the cost of extra setup. A group of skills must work together for this
   request; individually relevant skills can still be redundant or conflict.
4. State the route in one short line, such as `Preflight: graphify +
   product-quality-loop — architecture context and verified implementation.`
   Then begin the main task in the same turn.
5. Use `agent-workflow-pipeline` when the task combines repository context,
   public research, implementation, optional model routing, and verification.
   Treat it as the coordinator; do not separately load a component skill when
   the pipeline already owns that phase.
6. Only if no selected skill covers a material capability, read
   [skill-discovery.md](references/skill-discovery.md). Recommend a verified
   candidate, but do not install it, connect a service, or add credentials
   without the user's explicit authorization.

## Why routing is explicit

Large skill libraries break implicit routing. When irrelevant skills were added
to a library, agents loaded the right skill far less often (recall 73.6% to
27.4% at 1,000 extra skills; runs loading no skill rose from 9.3% to 51.6%),
even though the same models still picked the right skills 73.9% of the time
when asked only to choose (arXiv 2610.18522). Preselection beat asking the
agent to plan its own skill use. So:

- Name the selected skills in the route line and in every worker brief
  ("Use the `<skill>` skill."); do not rely on a worker discovering them.
- Keep each runtime's always-visible skill set small; park large collections
  (for example a 98-skill research pack) outside the default skill roots and
  link to them on demand.
- Prefer a focused skill over a comprehensive one, and do not ship a skill the
  agent wrote for itself without testing it: curated skills raised pass rates
  by about 16 points on average while self-generated skills gave no benefit,
  and focused skills with 2-3 modules beat comprehensive documentation
  (SkillsBench, arXiv 2602.12670). Some tasks regress with a skill loaded, so
  measure a new skill against the no-skill run.
- Generic engineering skill packs rarely help on their own: 39 of 49 public
  software-engineering skills changed nothing, an average of +1.2%, and harmful
  ones anchored the agent on their own templates (SWE-Skills-Bench, arXiv
  2603.15401). The task's explicit instructions and the repository's
  conventions win over any skill's template; adopt an outside skill only after
  it beats the no-skill run on this project's tasks.

Use [evaluation.md](references/evaluation.md) when changing this skill or
checking its routing behavior. The test cases separate trigger accuracy from
route quality, so a broad description does not turn into indiscriminate skill
loading.

## Preferred engineering flow

For substantive software tasks, first consider the installed Addy Osmani engineering skills as the main lifecycle: `idea-refine` or `spec-driven-development` when requirements need definition; `planning-and-task-breakdown` for planning; `test-driven-development` and `incremental-implementation` for implementation; `debugging-and-error-recovery`, `code-review-and-quality`, and relevant domain skills for verification and review; and `shipping-and-launch` when release is requested. Select only the stages and skills that fit the task, alongside existing skills such as `session-supervisor` and `product-quality-loop`; do not load all 25 by default.

For behavior changes where meaningful automated tests are practical, prefer a focused failing test before implementation, followed by implementation and a passing test. Respect the user's instructions, existing repository practices, and proportionate verification; do not invent tests for trivial or unsuitable tasks. Batch related delegated implementation and test-fix work as directed by `session-supervisor`, preserving worker sessions and minimizing supervisor polling. These preferences do not override higher-priority instructions or authorize publication, purchases, or external actions.

## Open the working context

Every task that passes step 1 runs on the `working-context-notebook` flow. It
is the default working flow, not a route to select, so it does not count
toward the smallest skill set and is not named in the route line.

- Open the notebook as soon as the route is stated. Put the outcome in the
  goal and the completion evidence from step 1 in the tracker.
- While the selected skills run, log long raw output, keep exact values as
  sourced facts, and accept an edit at each phase or gate.
- Read the accepted revision back after any context compaction and before the
  final answer.

Skip it only where step 1 stops: a direct answer, a calculation, or an
isolated rewrite.

## Common local routes

- Repository architecture, file relationships, or codebase questions:
  `graphify`.
- Current public facts or structured source research: `scrapegraphai-research`.
- Platform content (YouTube, GitHub, Reddit, Twitter/X, Bilibili, RSS), or
  installing or updating Agent Reach: `scrapegraphai-research` (see
  scrapegraphai-research's `references/agent-reach.md`).
- User-authorized feature work, fixes, or release preparation:
  `product-quality-loop`.
- Coder workspace or TrueForge handoff: `remote-agent-graphify`.
- Cross-agent work that needs several of the routes above: `agent-workflow-pipeline`.
- Building or substantially extending a product end to end (research, questions,
  risk-appropriate planning, verification, integration and documentation): `engineering-workflow`.
- Profiling or prioritizing clients from a CRM export: `client-profiling`.
- Browser interaction or web-app testing: `agent-browser`.
- A repeatable end-to-end test suite for a web or mobile app: `npx e2e init`
  through `product-quality-loop` (see product-quality-loop's `references/e2e-testing.md`). It installs
  packages, a skill, and an MCP entry, so treat it as an install that needs the
  user's go-ahead unless they asked for it.
- Frontend design or UX work: `impeccable`.
- Security assessment: `application-security-testing`.

These are starting points. Use the task wording and each skill description to
make the final selection, including other installed skills that fit better.

## Keep the main task moving

Preflight is complete once the selected skill set is clear. Continue into the
main task immediately. When an online candidate would materially improve the
result, present its source, reputation signals, scope, and installation command
as a recommendation, then wait for the user to ask for installation.
