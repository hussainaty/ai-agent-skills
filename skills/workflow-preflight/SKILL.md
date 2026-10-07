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

Use [evaluation.md](references/evaluation.md) when changing this skill or
checking its routing behavior. The test cases separate trigger accuracy from
route quality, so a broad description does not turn into indiscriminate skill
loading.

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
  jury-reviewed tasks, testing, integration, graph, memory): `engineering-workflow`.
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
